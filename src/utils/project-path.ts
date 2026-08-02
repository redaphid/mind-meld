// The one place project paths are normalized (issue #33).
//
// Three incompatible formats used to coexist in projects.path — raw encoded
// directory names (`D--mechs-comfy`), lossy decodes (`D:/mechs/win/setup`),
// and cwd-corrected Windows paths (`D:\mechs\win-setup`) — because every write
// path made its own guess. Nothing outside this file may invent a path format:
// `upsertProject` canonicalizes automatically, so sync, /api/ingest and MCP
// callers never think about it.
//
// Canonical form: unix-style. Forward slashes only, drive letters uppercase
// (`D:/mechs/mindmeld`), no trailing separator (roots `/` and `D:/` keep
// theirs), case otherwise preserved. UNC paths keep their leading `//`.
//
// Truth model: a session's `cwd` is the only lossless source of a project's
// path. Claude Code's encoded directory names (`-home-me-my-app`) map both
// `/` and `.` and `-` to `-`, so decoding is guesswork — this module never
// decodes. A cwd is trusted only when re-encoding it reproduces the directory
// name (`verifyCwdAgainstDirName`); a project no cwd ever verified keeps the
// raw directory name as its path, which honestly says "unknown" instead of
// inventing a directory that does not exist.

// Windows drive root, e.g. `D:` / `d:/foo`. A path in this form is SELF-
// evidence of a case-insensitive filesystem: no other OS produces it.
const DRIVE_RE = /^[A-Za-z]:(\/|$)/
// Possible WSL drvfs mount of a Windows drive, e.g. `/mnt/d/foo`. Unlike
// DRIVE_RE this shape proves nothing on its own — on a plain Linux host
// `/mnt/d` is an ordinary case-SENSITIVE mount, where `/mnt/d/Data` and
// `/mnt/d/data` are two different directories. Every case-insensitive
// comparison below therefore requires positive evidence that the host really
// is Windows-backed (`windowsHost`), which callers get from a drive-form path
// on the same machine or from the reported OS (`isWindowsHostOs`).
const MNT_RE = /^\/mnt\/[A-Za-z](\/|$)/

// Positive evidence that a host's filesystem is case-insensitive, i.e. that
// its `/mnt/<letter>` really is a Windows drive seen through drvfs.
export type HostHint = { windowsHost?: boolean }

// Which reported operating systems make `/mnt/<letter>` a Windows drive.
// `process.platform` alone cannot answer this — WSL reports `linux` — so
// `wsl` is detected separately (src/config.ts) and is precisely the value
// that matters here.
export const isWindowsHostOs = (os: string | null | undefined): boolean => os === 'win32' || os === 'wsl'

// Normalize any path-shaped string to the canonical form. Non-path strings —
// raw encoded dir names (`D--mechs-comfy`), pseudo-projects (`phone`) — pass
// through untouched, so the function is safe to apply unconditionally and is
// idempotent. Empty input becomes null: "no path" must be one value, not
// '' sometimes and NULL other times.
export const canonicalizeProjectPath = (input: string | null | undefined): string | null => {
  if (input === null || input === undefined) return null
  const trimmed = input.trim()
  if (trimmed === '') return null
  // Not path-shaped: nothing to normalize, never invent structure.
  if (!trimmed.includes('/') && !trimmed.includes('\\') && !/^[A-Za-z]:$/.test(trimmed)) return trimmed

  let p = trimmed.replace(/\\/g, '/')
  // A UNC path (`//server/share`) keeps exactly two leading slashes.
  const unc = p.startsWith('//')
  p = (unc ? '/' : '') + p.replace(/\/{2,}/g, '/')
  if (/^[a-z]:(\/|$)/.test(p)) p = p[0].toUpperCase() + p.slice(1)
  // Bare drive means the drive root.
  if (/^[A-Za-z]:$/.test(p)) p = p + '/'
  // No trailing separator — except the roots `/` and `D:/`, which are nothing
  // without theirs.
  while (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1)
  return p
}

// Claude Code names a project directory by replacing every character of the
// cwd that is not [A-Za-z0-9] with '-'. This is the forward (lossless-to-
// verify, lossy-to-invert) direction of that encoding, used to check a cwd
// against a directory name — never to decode one.
export const encodeClaudeProjectDir = (path: string): string => path.replace(/[^A-Za-z0-9]/g, '-')

// Does this cwd verifiably belong to this encoded project directory?
// Exact match first; drive-form Windows paths also match case-insensitively
// because the filesystem does (live data holds both `D:\Projects\sporefall-art`
// and `d:\Projects\sporefall-art` for the one directory). `/mnt` paths only
// get that leniency when the host is known to be Windows-backed.
export const verifyCwdAgainstDirName = (dirName: string, cwd: string, hint: HostHint = {}): boolean => {
  const canonical = canonicalizeProjectPath(cwd)
  if (canonical === null) return false
  const encoded = encodeClaudeProjectDir(canonical)
  if (encoded === dirName) return true
  return caseInsensitive(canonical, hint) && encoded.toLowerCase() === dirName.toLowerCase()
}

// The single rule for "may these two spellings differ only in case?".
const caseInsensitive = (canonicalPath: string, hint: HostHint): boolean =>
  DRIVE_RE.test(canonicalPath) || (MNT_RE.test(canonicalPath) && hint.windowsHost === true)

// The project path sync should store, given what it actually knows: the
// encoded directory name (always) and a session cwd (sometimes). cwd wins
// when it verifies; otherwise the raw directory name is kept as the honest
// "unknown". `verified: false` marks exactly the fallback case.
export const resolveProjectPath = (input: {
  dirName: string
  cwd?: string | null
  windowsHost?: boolean
}): { path: string; verified: boolean } => {
  if (input.cwd && verifyCwdAgainstDirName(input.dirName, input.cwd, { windowsHost: input.windowsHost })) {
    return { path: canonicalizeProjectPath(input.cwd)!, verified: true }
  }
  return { path: input.dirName, verified: false }
}

// Every canonical spelling of the same real directory: the path itself, plus
// its cross-form twin when it is a Windows drive seen either natively
// (`D:/x`) or through WSL (`/mnt/d/x`). Used to match a cwd against stored
// paths regardless of which side of the drvfs mount recorded it.
export const projectPathVariants = (path: string): string[] => {
  const canonical = canonicalizeProjectPath(path)
  if (canonical === null) return []
  if (DRIVE_RE.test(canonical)) {
    const rest = canonical.slice(2) === '/' ? '' : canonical.slice(2)
    return [canonical, `/mnt/${canonical[0].toLowerCase()}${rest}`]
  }
  if (MNT_RE.test(canonical)) {
    const drive = canonical[5].toUpperCase()
    const rest = canonical.slice(6)
    return [canonical, `${drive}:${rest === '' ? '/' : rest}`]
  }
  return [canonical]
}

// Two paths are the same project when their equivalence keys match.
// Drive-form Windows paths collapse to a lowercased key because that
// filesystem is case-insensitive and the `D:` form proves it is that
// filesystem. A `/mnt/<letter>` path only joins them when the caller supplies
// evidence that the host is Windows-backed; otherwise it is treated as what
// it looks like on any other machine — an ordinary case-sensitive unix mount.
// Unix paths always compare exactly. Non-paths (raw encoded names,
// pseudo-projects) get no key — a raw name proves nothing about directory
// identity, so it never merges with anything.
export const projectPathEquivalenceKey = (
  path: string | null | undefined,
  hint: HostHint = {}
): string | null => {
  const canonical = canonicalizeProjectPath(path)
  if (canonical === null || !canonical.includes('/')) return null
  if (MNT_RE.test(canonical) && hint.windowsHost === true) {
    const rest = canonical.slice(6)
    return `${canonical[5].toLowerCase()}:${rest === '' ? '/' : rest}`.toLowerCase()
  }
  if (DRIVE_RE.test(canonical)) return canonical.toLowerCase()
  return canonical
}

// Find, among existing project rows, the one that IS this project — either
// because its path is an equivalent spelling of the incoming path, or (when
// the incoming path is just a raw encoded dir name) because one of its path's
// spellings encodes to that dir name. This is what keeps a merged project
// merged: after 019 collapses `D--tools-comfy` and `-mnt-d-tools-comfy` into
// one row, the next sync of either directory must adopt that row, not
// resurrect the duplicate.
export const findEquivalentIn = <T extends { path: string | null }>(
  rows: T[],
  externalId: string,
  canonicalPath: string | null,
  hint: HostHint = {}
): T | null => {
  const incoming = canonicalizeProjectPath(canonicalPath)
  for (const row of rows) {
    // Raw encoded names and pseudo-paths prove nothing about directory
    // identity — a row that only knows its raw name can never be adopted.
    if (row.path === null || !row.path.includes('/')) continue
    const stored = canonicalizeProjectPath(row.path)
    if (stored === null) continue
    // Evidence, not shape: a `D:` path on either side proves the directory
    // lives on a case-insensitive filesystem, so its drvfs twin does too. Two
    // bare `/mnt` paths prove nothing and stay case-sensitive unless the
    // caller knows the host (finding 1 of the round-2 review).
    const rowHint: HostHint = {
      windowsHost: hint.windowsHost === true || DRIVE_RE.test(stored) || (incoming !== null && DRIVE_RE.test(incoming)),
    }
    const incomingKey = projectPathEquivalenceKey(incoming, rowHint)
    if (incomingKey !== null) {
      if (projectPathEquivalenceKey(stored, rowHint) === incomingKey) return row
      continue
    }
    // Incoming path is not a real path — match the raw dir name against what
    // each stored path (in any of its spellings) would have been encoded as.
    for (const variant of projectPathVariants(stored)) {
      const encoded = encodeClaudeProjectDir(variant)
      if (encoded === externalId) return row
      if (caseInsensitive(stored, rowHint) && encoded.toLowerCase() === externalId.toLowerCase()) return row
    }
  }
  return null
}

// True when this path lives on a case-insensitive (Windows-backed)
// filesystem, so SQL matching may use ILIKE instead of LIKE. Same gate as
// everywhere else: the `D:` form is self-evident, `/mnt` needs a known host.
export const isWindowsBackedPath = (path: string, hint: HostHint = {}): boolean =>
  caseInsensitive(canonicalizeProjectPath(path) ?? path, hint)
