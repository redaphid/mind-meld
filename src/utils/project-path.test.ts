import { describe, it, expect } from 'vitest'
import {
  canonicalizeProjectPath,
  encodeClaudeProjectDir,
  verifyCwdAgainstDirName,
  resolveProjectPath,
  projectPathVariants,
  projectPathEquivalenceKey,
  findEquivalentIn,
  isWindowsBackedPath,
  isWindowsHostOs,
  pathSegments,
  lastPathSegment,
} from './project-path.js'

describe('canonicalizeProjectPath', () => {
  // Every case observed in the live projects table (issue #33 survey), plus
  // the edge shapes around them.
  it.each([
    // [input, canonical]
    // WSL / unix paths pass through
    ['/home/alice/Projects/mind-meld', '/home/alice/Projects/mind-meld'],
    ['/mnt/d/tools/comfy', '/mnt/d/tools/comfy'],
    // Windows backslash form -> forward slashes
    ['D:\\mechs\\mindmeld', 'D:/mechs/mindmeld'],
    ['C:\\Users\\alice\\Worktrees\\nfc-bead\\multi-demo', 'C:/Users/alice/Worktrees/nfc-bead/multi-demo'],
    // Already-forward-slash Windows form is stable
    ['D:/mechs/mindmeld', 'D:/mechs/mindmeld'],
    // Drive letter case is normalized up (live data holds d:\Projects\sporefall-art)
    ['d:\\Projects\\sporefall-art', 'D:/Projects/sporefall-art'],
    ['d:/projects', 'D:/projects'],
    // Path case is otherwise preserved — D:/Projects and D:/projects differ as text
    ['D:/Projects', 'D:/Projects'],
    // Drive roots
    ['D:\\', 'D:/'],
    ['D:', 'D:/'],
    ['d:', 'D:/'],
    // Trailing separators dropped, roots keep theirs
    ['/home/user/project/', '/home/user/project'],
    ['/home/user/project///', '/home/user/project'],
    ['D:\\mechs\\chat\\', 'D:/mechs/chat'],
    ['/', '/'],
    // Duplicate separators collapse
    ['/home//user///x', '/home/user/x'],
    // UNC keeps its leading double slash, normalizes the rest
    ['\\\\server\\share\\dir', '//server/share/dir'],
    ['//server/share/', '//server/share'],
    // Whitespace trimmed
    ['  /home/user/x  ', '/home/user/x'],
    // Non-paths pass through untouched: raw encoded dir names, pseudo-projects
    ['D--mechs-comfy', 'D--mechs-comfy'],
    ['-home-alice-Projects-clasp-laser-cube', '-home-alice-Projects-clasp-laser-cube'],
    ['phone', 'phone'],
    ['android-post-notifications', 'android-post-notifications'],
  ])('%s -> %s', (input, expected) => {
    expect(canonicalizeProjectPath(input)).toBe(expected)
  })

  it('maps empty and missing to null', () => {
    expect(canonicalizeProjectPath('')).toBeNull()
    expect(canonicalizeProjectPath('   ')).toBeNull()
    expect(canonicalizeProjectPath(null)).toBeNull()
    expect(canonicalizeProjectPath(undefined)).toBeNull()
  })

  it('is idempotent over every matrix row', () => {
    for (const input of [
      '/home/alice/Projects/mind-meld',
      'D:\\mechs\\mindmeld',
      'd:',
      '\\\\server\\share\\dir',
      'D--mechs-comfy',
      'phone',
    ]) {
      const once = canonicalizeProjectPath(input)
      expect(canonicalizeProjectPath(once)).toBe(once)
    }
  })
})

describe('encodeClaudeProjectDir', () => {
  // These pairs are real (external_id, session cwd) rows from the live DB —
  // the encode must reproduce Claude Code's own directory names.
  it.each([
    ['/home/alice/Projects/mind-meld', '-home-alice-Projects-mind-meld'],
    ['/home/bob/Projects/rogue-gm/.claude/worktrees/sonnet-gm-latency', '-home-bob-Projects-rogue-gm--claude-worktrees-sonnet-gm-latency'],
    ['D:/mechs/win-setup', 'D--mechs-win-setup'],
    ['C:/Users/alice/wsl', 'C--Users-alice-wsl'],
    ['/mnt/d/tools/comfy', '-mnt-d-tools-comfy'],
    ['D:/', 'D--'],
  ])('%s -> %s', (path, encoded) => {
    expect(encodeClaudeProjectDir(path)).toBe(encoded)
  })
})

describe('verifyCwdAgainstDirName', () => {
  it('accepts a cwd that re-encodes to the directory name', () => {
    expect(verifyCwdAgainstDirName('D--mechs-win-setup', 'D:\\mechs\\win-setup')).toBe(true)
    expect(verifyCwdAgainstDirName('-home-bob-Projects-fish-shell-stuff', '/home/bob/Projects/fish-shell-stuff')).toBe(true)
    expect(verifyCwdAgainstDirName('D--', 'D:\\')).toBe(true)
  })

  it('accepts drive-form Windows cwds case-insensitively (the filesystem does)', () => {
    expect(verifyCwdAgainstDirName('D--Projects-sporefall-art', 'd:\\Projects\\sporefall-art')).toBe(true)
  })

  it('case-folds /mnt only when the host is known to be Windows-backed', () => {
    // `/mnt/d` is drvfs on WSL and case-insensitive — but on a plain Linux box
    // it is an ordinary ext4 mount where `Data` and `data` are two directories.
    // The shape of the path is not evidence of which; the host is.
    expect(
      verifyCwdAgainstDirName('-mnt-d-Projects-sporefall-art', '/mnt/d/projects/Sporefall-Art', {
        windowsHost: true,
      })
    ).toBe(true)
    expect(verifyCwdAgainstDirName('-mnt-d-Projects-sporefall-art', '/mnt/d/projects/Sporefall-Art')).toBe(false)
    expect(verifyCwdAgainstDirName('-mnt-d-data', '/mnt/d/Data')).toBe(false)
  })

  it('rejects a cwd from a different directory — the worktree-parent trap', () => {
    // Live row 26748: the transcript recorded the parent repo as cwd, but the
    // project directory is the worktree. Using that cwd would misname the row.
    expect(
      verifyCwdAgainstDirName(
        '-home-bob-Projects-rogue-brain--claude-worktrees-starry-jingling-stearns',
        '/home/bob/Projects/rogue-brain'
      )
    ).toBe(false)
  })

  it('does not treat unix paths case-insensitively', () => {
    expect(verifyCwdAgainstDirName('-home-user-App', '/home/user/app')).toBe(false)
  })
})

describe('resolveProjectPath', () => {
  it('prefers the verified cwd, canonicalized', () => {
    expect(resolveProjectPath({ dirName: 'D--mechs-win-setup', cwd: 'D:\\mechs\\win-setup' })).toEqual({
      path: 'D:/mechs/win-setup',
      verified: true,
    })
  })

  it('only case-folds a /mnt cwd for a host that is Windows-backed', () => {
    const input = { dirName: '-mnt-d-Data', cwd: '/mnt/d/data' }
    expect(resolveProjectPath({ ...input, windowsHost: true })).toEqual({
      path: '/mnt/d/data',
      verified: true,
    })
    // Same inputs on a plain Linux host: a different directory, so the row
    // keeps its honest raw name instead of being renamed to its neighbour.
    expect(resolveProjectPath(input)).toEqual({ path: '-mnt-d-Data', verified: false })
  })

  it('falls back to the raw dir name when there is no cwd — never decodes', () => {
    expect(resolveProjectPath({ dirName: 'D--mechs-win-setup' })).toEqual({
      path: 'D--mechs-win-setup',
      verified: false,
    })
    expect(resolveProjectPath({ dirName: '-home-user-a-b', cwd: null })).toEqual({
      path: '-home-user-a-b',
      verified: false,
    })
  })

  it('falls back when the cwd belongs to a different directory', () => {
    expect(
      resolveProjectPath({
        dirName: '-home-bob-Projects-rogue-brain--claude-worktrees-starry-jingling-stearns',
        cwd: '/home/bob/Projects/rogue-brain',
      })
    ).toEqual({
      path: '-home-bob-Projects-rogue-brain--claude-worktrees-starry-jingling-stearns',
      verified: false,
    })
  })
})

describe('projectPathVariants', () => {
  it('gives both spellings of a Windows-backed directory', () => {
    expect(projectPathVariants('D:\\tools\\comfy')).toEqual(['D:/tools/comfy', '/mnt/d/tools/comfy'])
    expect(projectPathVariants('/mnt/d/tools/comfy')).toEqual(['/mnt/d/tools/comfy', 'D:/tools/comfy'])
    expect(projectPathVariants('D:/')).toEqual(['D:/', '/mnt/d'])
  })

  it('gives just the canonical form for plain unix paths', () => {
    expect(projectPathVariants('/home/user/x/')).toEqual(['/home/user/x'])
  })

  it('gives nothing for empty input', () => {
    expect(projectPathVariants('')).toEqual([])
  })
})

describe('projectPathEquivalenceKey', () => {
  it('collapses all spellings of one Windows directory to one key', () => {
    const spellings = ['D:\\mechs\\mindmeld', 'D:/mechs/mindmeld', 'd:/MECHS/mindmeld', '/mnt/d/mechs/mindmeld']
    const keys = new Set(spellings.map(s => projectPathEquivalenceKey(s, { windowsHost: true })))
    expect(keys.size).toBe(1)
    expect(keys.has('d:/mechs/mindmeld')).toBe(true)
  })

  // Round-2 finding 1: the key folded case for ANY `/mnt/<letter>/` path, so
  // two distinct directories on a Linux host collapsed into one — the same
  // data-destroying class the verification gate already blocks.
  it('treats /mnt as a case-sensitive unix mount unless the host is Windows-backed', () => {
    expect(projectPathEquivalenceKey('/mnt/d/Data')).not.toBe(projectPathEquivalenceKey('/mnt/d/data'))
    expect(projectPathEquivalenceKey('/mnt/d/Data')).toBe('/mnt/d/Data')
    expect(projectPathEquivalenceKey('/mnt/d/Data', { windowsHost: true })).toBe(
      projectPathEquivalenceKey('/mnt/d/data', { windowsHost: true })
    )
  })

  it('recognises which reported OSes make /mnt Windows-backed', () => {
    // WSL reports platform `linux`, so the platform alone cannot answer this;
    // `wsl` is detected separately and is exactly the case that matters here.
    expect(isWindowsHostOs('win32')).toBe(true)
    expect(isWindowsHostOs('wsl')).toBe(true)
    expect(isWindowsHostOs('linux')).toBe(false)
    expect(isWindowsHostOs('darwin')).toBe(false)
    expect(isWindowsHostOs(null)).toBe(false)
  })

  it('keeps unix paths exact-case and distinct across users', () => {
    expect(projectPathEquivalenceKey('/home/alice/Projects/mind-meld')).toBe('/home/alice/Projects/mind-meld')
    expect(projectPathEquivalenceKey('/home/alice/Projects/mind-meld')).not.toBe(
      projectPathEquivalenceKey('/home/bob/Projects/mind-meld')
    )
    expect(projectPathEquivalenceKey('/home/user/App')).not.toBe(projectPathEquivalenceKey('/home/user/app'))
  })

  it('refuses to key non-paths — raw names never merge on guesswork', () => {
    expect(projectPathEquivalenceKey('D--mechs-comfy')).toBeNull()
    expect(projectPathEquivalenceKey('phone')).toBeNull()
    expect(projectPathEquivalenceKey(null)).toBeNull()
  })

  it('does not confuse /mnt/data with a drvfs drive', () => {
    expect(projectPathEquivalenceKey('/mnt/data/x')).toBe('/mnt/data/x')
  })
})

describe('findEquivalentIn', () => {
  const rows = [
    { id: 1, path: 'D:/tools/comfy' },
    { id: 2, path: '/home/bob/Projects/mind-meld' },
    { id: 3, path: null },
    { id: 4, path: 'D--mechs-comfy' }, // raw fallback row: must never be adopted into
  ]

  it('matches an incoming real path across drvfs spellings and case', () => {
    expect(findEquivalentIn(rows, '-mnt-d-tools-comfy', '/mnt/d/tools/comfy')?.id).toBe(1)
    expect(findEquivalentIn(rows, 'D--Tools-Comfy', 'D:/Tools/Comfy')?.id).toBe(1)
  })

  it('matches a raw dir name against what each stored path would encode to', () => {
    // After 019 merges the drvfs pair, a fresh sync of the WSL-side directory
    // starts from just the dir name — it must adopt the surviving row.
    expect(findEquivalentIn(rows, '-mnt-d-tools-comfy', null)?.id).toBe(1)
    expect(findEquivalentIn(rows, 'D--tools-comfy', null)?.id).toBe(1)
    expect(findEquivalentIn(rows, 'd--TOOLS-comfy', null)?.id).toBe(1)
    expect(findEquivalentIn(rows, '-home-bob-Projects-mind-meld', null)?.id).toBe(2)
  })

  it('does not case-fold unix dir names', () => {
    expect(findEquivalentIn(rows, '-home-bob-projects-MIND-meld', null)).toBeNull()
  })

  // Round-2 finding 1, runtime half: this is the standing write-layer defect —
  // `upsertProject` adopted the wrong row, so sessions from a second Linux
  // directory were filed under the first one forever.
  it('does not adopt a /mnt row that differs only in case on a non-Windows host', () => {
    const linuxRows = [{ id: 7, path: '/mnt/d/Data' }]
    expect(findEquivalentIn(linuxRows, '-mnt-d-data', '/mnt/d/data')).toBeNull()
    expect(findEquivalentIn(linuxRows, '-mnt-d-data', null)).toBeNull()
    // Same host, told it is Windows-backed: now they are one directory.
    expect(findEquivalentIn(linuxRows, '-mnt-d-data', '/mnt/d/data', { windowsHost: true })?.id).toBe(7)
  })

  it('still adopts across the drvfs boundary when a drive-form path proves Windows', () => {
    // A stored `D:/…` path is self-evidence of a case-insensitive filesystem,
    // so no external hint is needed for the real live pairs 019 merges.
    expect(findEquivalentIn(rows, '-mnt-d-Tools-Comfy', '/mnt/d/Tools/Comfy')?.id).toBe(1)
  })

  it('finds nothing for unrelated projects or raw-only rows', () => {
    expect(findEquivalentIn(rows, 'D--other-place', null)).toBeNull()
    expect(findEquivalentIn(rows, 'D--mechs-comfy', null)).toBeNull()
    expect(findEquivalentIn(rows, 'phone', 'phone')).toBeNull()
  })
})

describe('isWindowsBackedPath', () => {
  it.each([
    ['D:/x', true],
    // `/mnt/d` is only Windows-backed on a Windows-backed host — see finding 1.
    ['/mnt/d/x', false],
    ['/mnt/data/x', false],
    ['/home/user/x', false],
    ['//server/share', false],
  ])('%s -> %s', (path, expected) => {
    expect(isWindowsBackedPath(path)).toBe(expected)
  })
})

// `node:path.join` emits '\' on Windows and '/' elsewhere, and transcripts carry
// either regardless of host. A bare `split('/')` therefore yields the WHOLE path
// as one segment on Windows — which silently made the project dirName
// `C:\...\projects\-home-u-proj` and indexed everything under a garbage key.
describe('lastPathSegment', () => {
  it.each([
    ['/home/u/.claude/projects/-home-u-proj', '-home-u-proj'],
    ['C:\\Users\\u\\projects\\-home-u-proj', '-home-u-proj'],
    // Mixed separators: a Windows base joined onto a POSIX tail.
    ['C:\\Users\\u\\projects/-home-u-proj', '-home-u-proj'],
    ['sess-1.jsonl', 'sess-1.jsonl'],
  ])('%s -> %s', (path, expected) => {
    expect(lastPathSegment(path)).toBe(expected)
  })

  // The bug it replaces: the old expression returned the whole string here.
  it('does not return the whole path for a backslash path', () => {
    const windows = 'C:\\Users\\u\\projects\\-home-u-proj'
    expect(lastPathSegment(windows)).not.toBe(windows)
  })
})

describe('pathSegments', () => {
  it('splits on either separator', () => {
    expect(pathSegments('a/b/c')).toEqual(['a', 'b', 'c'])
    expect(pathSegments('a\\b\\c')).toEqual(['a', 'b', 'c'])
    expect(pathSegments('a\\b/c')).toEqual(['a', 'b', 'c'])
  })

  // parentExternalIdFromRawPath locates a 'subagents' marker by segment, so a
  // Windows path that never splits would hide the marker and orphan the child.
  it('finds a subagents marker in a Windows path', () => {
    expect(pathSegments('C:\\p\\sess-1\\subagents\\agent-abc.jsonl')).toContain('subagents')
  })
})
