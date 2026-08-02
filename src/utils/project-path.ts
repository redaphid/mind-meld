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

// Windows drive root, e.g. `D:` / `d:/foo`.
const DRIVE_RE = /^[A-Za-z]:(\/|$)/
// WSL drvfs mount of a Windows drive, e.g. `/mnt/d/foo`.
const MNT_RE = /^\/mnt\/[A-Za-z](\/|$)/

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
// Exact match first; Windows paths also match case-insensitively because the
// filesystem does (live data holds both `D:\Projects\sporefall-art` and
// `d:\Projects\sporefall-art` for the one directory).
export const verifyCwdAgainstDirName = (dirName: string, cwd: string): boolean => {
  const canonical = canonicalizeProjectPath(cwd)
  if (canonical === null) return false
  const encoded = encodeClaudeProjectDir(canonical)
  if (encoded === dirName) return true
  const windowsish = DRIVE_RE.test(canonical) || MNT_RE.test(canonical)
  return windowsish && encoded.toLowerCase() === dirName.toLowerCase()
}

// The project path sync should store, given what it actually knows: the
// encoded directory name (always) and a session cwd (sometimes). cwd wins
// when it verifies; otherwise the raw directory name is kept as the honest
// "unknown". `verified: false` marks exactly the fallback case.
export const resolveProjectPath = (input: {
  dirName: string
  cwd?: string | null
}): { path: string; verified: boolean } => {
  if (input.cwd && verifyCwdAgainstDirName(input.dirName, input.cwd)) {
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
// Windows-backed paths (drive or /mnt form) collapse to a lowercased drive
// form because that filesystem is case-insensitive; unix paths compare
// exactly. Non-paths (raw encoded names, pseudo-projects) get no key — a raw
// name proves nothing about directory identity, so it never merges with
// anything.
export const projectPathEquivalenceKey = (path: string | null | undefined): string | null => {
  const canonical = canonicalizeProjectPath(path)
  if (canonical === null || !canonical.includes('/')) return null
  if (MNT_RE.test(canonical)) {
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
  canonicalPath: string | null
): T | null => {
  const incomingKey = projectPathEquivalenceKey(canonicalPath)
  for (const row of rows) {
    // Raw encoded names and pseudo-paths prove nothing about directory
    // identity — a row that only knows its raw name can never be adopted.
    if (row.path === null || !row.path.includes('/')) continue
    if (incomingKey !== null) {
      if (projectPathEquivalenceKey(row.path) === incomingKey) return row
      continue
    }
    // Incoming path is not a real path — match the raw dir name against what
    // each stored path (in any of its spellings) would have been encoded as.
    for (const variant of projectPathVariants(row.path)) {
      const encoded = encodeClaudeProjectDir(variant)
      if (encoded === externalId) return row
      const windowsish = DRIVE_RE.test(variant) || MNT_RE.test(variant)
      if (windowsish && encoded.toLowerCase() === externalId.toLowerCase()) return row
    }
  }
  return null
}

// True when this variant lives on a case-insensitive (Windows-backed)
// filesystem, so SQL matching may use ILIKE instead of LIKE.
export const isWindowsBackedPath = (path: string): boolean => DRIVE_RE.test(path) || MNT_RE.test(path)
