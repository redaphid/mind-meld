// Migration 019 against fixture rows replicating every path pathology the
// live survey found (issue #33), plus proof that the runtime write path needs
// no caller-side normalization at all.
//
// Needs a reachable Postgres: see src/__tests__/scratch-database.ts. It builds a
// scratch database, applies the real init-db chain, seeds fixtures, runs 019
// through the migration runner exactly as mcp does at startup, and asserts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import pg from 'pg'
import { INIT_DB, PG, applyInitDb, createScratchDatabase, dbAvailable, psqlFile } from '../__tests__/scratch-database.js'
let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
let SCRATCH_DB: string
let db: pg.Client
let sourceId: number

const project = async (externalId: string, path: string | null, machine: string | null, srcId = sourceId) => {
  const r = await db.query(
    `INSERT INTO projects (source_id, external_id, path, name, machine)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [srcId, externalId, path, externalId, machine]
  )
  return r.rows[0].id as number
}

const session = async (projectId: number, externalId: string, cwd: string | null) => {
  await db.query(`INSERT INTO sessions (project_id, external_id, cwd) VALUES ($1, $2, $3)`, [
    projectId,
    externalId,
    cwd,
  ])
}

const pathOf = async (externalId: string) => {
  const r = await db.query('SELECT path FROM projects WHERE external_id = $1', [externalId])
  return r.rows.length === 1 ? (r.rows[0].path as string | null) : undefined
}

beforeAll(async () => {
  if (!dbAvailable) return
  scratch = await createScratchDatabase('mm_test_019')
  SCRATCH_DB = scratch.name

  // The real migration chain, exactly as src/db/migrations.ts applies it —
  // everything before 019, so fixtures exist in the world 019 will meet.
  await applyInitDb(SCRATCH_DB, (f) => f < '019')

  db = new pg.Client({ ...PG, database: SCRATCH_DB })
  await db.connect()
  const src = await db.query(`SELECT id FROM sources WHERE name = 'claude_code'`)
  sourceId = src.rows[0].id

  // --- fixtures: one row per live pathology ---
  // 1. Raw Windows dir, session cwd verifies -> canonical drive path.
  const raw = await project('D--mechs-win-setup', 'D--mechs-win-setup', 'windows')
  await session(raw, 's-raw-1', 'D:\\mechs\\win-setup')

  // 2. Lossy unix decode, session cwd verifies -> real hyphenated path.
  const lossy = await project(
    '-home-u-Projects-fish-shell-stuff',
    '/home/u/Projects/fish/shell/stuff',
    'zod2'
  )
  await session(lossy, 's-lossy-1', '/home/u/Projects/fish-shell-stuff')

  // 3. Lossy decode, NO cwd anywhere -> reverts to the raw name.
  await project('-home-u-Projects-clasp-laser-cube', '/home/u/Projects/clasp/laser/cube', 'zod2')

  // 4. Worktree double-slash decode whose only cwd is the PARENT repo
  //    (does not re-encode to the dir name) -> raw name, not the parent.
  const worktree = await project(
    '-home-u-Projects-app--claude-worktrees-w1',
    '/home/u/Projects/app//claude/worktrees/w1',
    'zod2'
  )
  await session(worktree, 's-wt-1', '/home/u/Projects/app')

  // 5. drvfs duplicate pair: same directory through Windows and WSL.
  //    Windows side has more sessions -> survives; WSL side merges in.
  const winSide = await project('D--tools-comfy', 'D--tools-comfy', 'windows')
  await session(winSide, 's-comfy-w1', 'D:\\tools\\comfy')
  await session(winSide, 's-comfy-w2', 'D:\\tools\\comfy')
  const wslSide = await project('-mnt-d-tools-comfy', '/mnt/d/tools/comfy', 'windows')
  await session(wslSide, 's-comfy-l1', '/mnt/d/tools/comfy')

  // 6. Case duplicate pair on the same drive (D--projects vs D--Projects).
  const lower = await project('D--projects', 'D--projects', 'windows')
  await session(lower, 's-proj-1', 'D:\\projects')
  const upper = await project('D--Projects', 'D--Projects', 'windows')
  await session(upper, 's-proj-2', 'D:\\Projects')

  // 7. Backslash cwd with lowercase drive and trailing slash still verifies.
  const messy = await project('D--mechs-chat', 'D:\\mechs\\chat', 'windows')
  await session(messy, 's-chat-1', 'd:\\mechs\\chat\\')

  // 8. Pseudo-project from another source: path '' becomes NULL, untouched
  //    otherwise, never merged.
  const phoneSrc = await db.query(
    `INSERT INTO sources (name, display_name) VALUES ('phone', 'Phone') RETURNING id`
  )
  const phone = await project('phone', '', 'phone', phoneSrc.rows[0].id)
  await session(phone, 's-phone-1', null)

  // 9. Two different users' unix paths that must NOT merge.
  const userA = await project('-home-alice-Projects-app', '/home/alice/Projects/app', 'zod2')
  await session(userA, 's-a-1', '/home/alice/Projects/app')
  const userB = await project('-home-bob-Projects-app', '/home/bob/Projects/app', 'other')
  await session(userB, 's-b-1', '/home/bob/Projects/app')

  // 10. Round-1 review repro: two case-DISTINCT unix directories. Unix
  //     filesystems are case-sensitive, so `/home/u/App` verifies only the
  //     `-home-u-App` row; against `-home-u-app` it is a different directory
  //     and must neither rename the row nor let the pair merge.
  const unixLower = await project('-home-u-app', '/home/u/app', 'zod2')
  await session(unixLower, 's-case-1', '/home/u/App')
  const unixUpper = await project('-home-u-App', '-home-u-App', 'zod2')
  await session(unixUpper, 's-case-2', '/home/u/App')

  // 11. Round-2 review repro: the same case-distinct pair, but under `/mnt/d`
  //     on a machine that has never reported a Windows drive path. `/mnt/d`
  //     is drvfs only on WSL; here it is an ordinary ext4 mount, so these are
  //     two real directories and merging them would destroy one.
  const mntLower = await project('-mnt-d-data', '/mnt/d/data', 'linuxbox')
  await session(mntLower, 's-mnt-1', '/mnt/d/data')
  const mntUpper = await project('-mnt-d-Data', '/mnt/d/Data', 'linuxbox')
  await session(mntUpper, 's-mnt-2', '/mnt/d/Data')

  // Give the drvfs husk a data_class override the keeper lacks — the merge
  // must carry it over, not drop it.
  await db.query(`UPDATE projects SET data_class = 'coding' WHERE external_id = '-mnt-d-tools-comfy'`)

  await psqlFile(SCRATCH_DB, join(INIT_DB, '019-canonical-project-paths.sql'))

  // Everything after 019, so the runtime write path below meets the same
  // schema production does (020 adds the os column upsertProject stamps).
  await applyInitDb(SCRATCH_DB, (f) => f > '019z')
}, 120_000)

afterAll(async () => {
  await db?.end().catch(() => {})
  await scratch?.drop()
})

describe.skipIf(!dbAvailable)('migration 019 (scratch database)', () => {
  it('re-derives verified paths into the canonical unix-style form', async () => {
    expect(await pathOf('D--mechs-win-setup')).toBe('D:/mechs/win-setup')
    expect(await pathOf('-home-u-Projects-fish-shell-stuff')).toBe('/home/u/Projects/fish-shell-stuff')
    expect(await pathOf('D--mechs-chat')).toBe('D:/mechs/chat')
  })

  it('reverts unverifiable lossy decodes to the honest raw name', async () => {
    expect(await pathOf('-home-u-Projects-clasp-laser-cube')).toBe('-home-u-Projects-clasp-laser-cube')
    // The parent-repo cwd must not have claimed the worktree project.
    expect(await pathOf('-home-u-Projects-app--claude-worktrees-w1')).toBe(
      '-home-u-Projects-app--claude-worktrees-w1'
    )
  })

  it('merges the drvfs pair into the session-richest row and repoints sessions', async () => {
    expect(await pathOf('-mnt-d-tools-comfy')).toBeUndefined() // husk deleted
    const keeper = await db.query(
      `SELECT p.id, p.path, count(s.id)::int AS sessions
       FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
       WHERE p.external_id = 'D--tools-comfy'
       GROUP BY p.id, p.path`
    )
    expect(keeper.rows).toHaveLength(1)
    expect(keeper.rows[0].path).toBe('D:/tools/comfy')
    expect(keeper.rows[0].sessions).toBe(3) // 2 native + 1 adopted from WSL twin
  })

  it('merges drive-case duplicates', async () => {
    const rows = await db.query(
      `SELECT external_id FROM projects WHERE external_id IN ('D--projects', 'D--Projects')`
    )
    expect(rows.rows).toHaveLength(1)
  })

  it('loses no sessions and leaves distinct unix projects alone', async () => {
    const sessions = await db.query('SELECT count(*)::int AS n FROM sessions')
    expect(sessions.rows[0].n).toBe(16)
    expect(await pathOf('-home-alice-Projects-app')).toBe('/home/alice/Projects/app')
    expect(await pathOf('-home-bob-Projects-app')).toBe('/home/bob/Projects/app')
  })

  it('never verifies unix cwds case-insensitively, and never merges case-distinct unix dirs', async () => {
    // `/home/u/App` is NOT `-home-u-app`'s directory: the row keeps only an
    // honest raw name (its old path was the lossy decode, now refused).
    expect(await pathOf('-home-u-app')).toBe('-home-u-app')
    // The exact-case row does verify.
    expect(await pathOf('-home-u-App')).toBe('/home/u/App')
    // Both rows still exist with their own sessions — no destructive merge.
    const rows = await db.query(
      `SELECT p.external_id, count(s.id)::int AS sessions
       FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
       WHERE p.external_id IN ('-home-u-app', '-home-u-App')
       GROUP BY p.external_id ORDER BY p.external_id`
    )
    expect(rows.rows).toEqual([
      { external_id: '-home-u-App', sessions: 1 },
      { external_id: '-home-u-app', sessions: 1 },
    ])
  })

  // Round-2 finding 1, migration half. The drvfs merge is driven by evidence,
  // not by the shape of the path: `/mnt/d/tools/comfy` merges because machine
  // `windows` demonstrably reports `D:` paths, while `/mnt/d/Data` on
  // `linuxbox` does not and stays its own project.
  it('never merges /mnt paths on a machine that has never reported a Windows drive', async () => {
    const rows = await db.query(
      `SELECT p.external_id, p.path, count(s.id)::int AS sessions
       FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
       WHERE p.external_id IN ('-mnt-d-data', '-mnt-d-Data')
       GROUP BY p.external_id, p.path ORDER BY p.external_id`
    )
    expect(rows.rows).toEqual([
      { external_id: '-mnt-d-Data', path: '/mnt/d/Data', sessions: 1 },
      { external_id: '-mnt-d-data', path: '/mnt/d/data', sessions: 1 },
    ])
  })

  // Round-2 finding 3: the migration overwrites paths in place and deletes
  // husk rows, so without this the only copy of the original state lived in
  // CSV files outside the database.
  it('leaves a pre-migration snapshot of projects inside the database', async () => {
    const backup = await db.query('SELECT external_id, path FROM projects_pre_019 ORDER BY external_id')
    // Every fixture row, with the paths as they were before 019 ran.
    expect(backup.rows).toContainEqual({ external_id: '-mnt-d-tools-comfy', path: '/mnt/d/tools/comfy' })
    expect(backup.rows).toContainEqual({
      external_id: '-home-u-Projects-clasp-laser-cube',
      path: '/home/u/Projects/clasp/laser/cube',
    })
    const live = await db.query('SELECT count(*)::int AS n FROM projects')
    expect(backup.rows.length).toBeGreaterThan(live.rows[0].n)
  })

  it('carries a husk data_class override onto the merge keeper', async () => {
    const keeper = await db.query(
      `SELECT data_class FROM projects WHERE external_id = 'D--tools-comfy'`
    )
    expect(keeper.rows[0].data_class).toBe('coding')
  })

  // Migration 020 (the operator's OS directive on #33). It seeds only what is
  // a fact — a `D:` path can have come from nowhere but Windows — and leaves
  // everything else honestly unreported rather than guessing.
  it('records the operating system where it is provable, and NULL where it is not', async () => {
    const rows = await db.query(
      `SELECT external_id, os FROM projects
       WHERE external_id IN ('D--tools-comfy', '-mnt-d-Data', '-home-alice-Projects-app')
       ORDER BY external_id`
    )
    expect(rows.rows).toEqual([
      { external_id: '-home-alice-Projects-app', os: null },
      { external_id: '-mnt-d-Data', os: null }, // could be WSL or Linux — never guessed
      { external_id: 'D--tools-comfy', os: 'win32' },
    ])
  })

  it('turns empty pseudo-paths into NULL without touching the project', async () => {
    expect(await pathOf('phone')).toBeNull()
  })

  it('leaves no backslash or interior double-slash paths behind', async () => {
    const bad = await db.query(
      String.raw`SELECT path FROM projects
       WHERE position('\' in path) > 0
          OR (position('//' in path) > 0 AND path NOT LIKE '//%')`
    )
    expect(bad.rows).toEqual([])
  })
})

// The no-burden proof: runtime code calls queries.upsertProject with whatever
// it has — Windows separators, raw dir names — and the canonical form appears
// in the database with no caller-side normalization anywhere.
describe.skipIf(!dbAvailable)('upsertProject normalizes and adopts automatically', () => {
  let queries: typeof import('./postgres.js').queries
  let closePool: typeof import('./postgres.js').closePool

  beforeAll(async () => {
    // Point the runtime pool at the scratch database; config reads env at
    // import time, so set it before the dynamic import.
    process.env.POSTGRES_DB = SCRATCH_DB
    const mod = await import('./postgres.js')
    queries = mod.queries
    closePool = mod.closePool
  })

  afterAll(async () => {
    await closePool?.()
  })

  it('stores the canonical form no matter what the caller sends', async () => {
    const id = await queries.upsertProject(sourceId, 'C--Users-u-stuff', 'C:\\Users\\u\\stuff\\', 'stuff')
    const row = await db.query('SELECT path FROM projects WHERE id = $1', [id])
    expect(row.rows[0].path).toBe('C:/Users/u/stuff')
  })

  it('never lets the raw-name fallback clobber a verified path', async () => {
    const id = await queries.upsertProject(sourceId, 'C--Users-u-stuff', 'C--Users-u-stuff', 'C--Users-u-stuff')
    const row = await db.query('SELECT path, name FROM projects WHERE id = $1', [id])
    expect(row.rows[0].path).toBe('C:/Users/u/stuff')
    expect(row.rows[0].name).toBe('stuff')
  })

  it('adopts the surviving row instead of resurrecting a merged twin', async () => {
    // 019 merged -mnt-d-tools-comfy into D--tools-comfy. A later sync of the
    // WSL-side directory starts from just the dir name — same row, no twin.
    const keeper = await db.query(`SELECT id FROM projects WHERE external_id = 'D--tools-comfy'`)
    const adoptedId = await queries.upsertProject(
      sourceId,
      '-mnt-d-tools-comfy',
      '-mnt-d-tools-comfy',
      '-mnt-d-tools-comfy'
    )
    expect(adoptedId).toBe(keeper.rows[0].id)
    const twins = await db.query(`SELECT id FROM projects WHERE external_id = '-mnt-d-tools-comfy'`)
    expect(twins.rows).toEqual([])
  })
})

// Round-2 finding 2: the PR's merge is justified by "every such pair carries
// machine='windows' on both sides — one host, one directory", but the code
// grouped by source_id and the equivalence key only. Two hosts that both
// report `/home/u/shared` are two different real directories, and merging
// them deleted one. The migration must refuse and roll back instead — the
// same "refuse rather than guess" rule as the session external_id collision.
// This needs its own scratch database because a correct run aborts.
describe.skipIf(!dbAvailable)('migration 019 refuses to merge across machines', () => {
  let cross: Awaited<ReturnType<typeof createScratchDatabase>>
  let CROSS_DB: string
  let crossDb: pg.Client

  beforeAll(async () => {
    cross = await createScratchDatabase('mm_test_019x')
    CROSS_DB = cross.name
    await applyInitDb(CROSS_DB, (f) => f < '019')

    crossDb = new pg.Client({ ...PG, database: CROSS_DB })
    await crossDb.connect()
    const src = await crossDb.query(`SELECT id FROM sources WHERE name = 'huddle'`)
    for (const [externalId, machine] of [
      ['shared-a', 'zod2'],
      ['shared-b', 'windows'],
    ]) {
      await crossDb.query(
        `INSERT INTO projects (source_id, external_id, path, name, machine)
         VALUES ($1, $2, '/home/u/shared', $2, $3)`,
        [src.rows[0].id, externalId, machine]
      )
    }
  }, 120_000)

  afterAll(async () => {
    await crossDb?.end().catch(() => {})
    await cross?.drop()
  })

  it('aborts instead of collapsing two hosts into one project', async () => {
    await expect(psqlFile(CROSS_DB, join(INIT_DB, '019-canonical-project-paths.sql'))).rejects.toThrow(
      /different machines/
    )
    const rows = await crossDb.query('SELECT external_id FROM projects ORDER BY external_id')
    expect(rows.rows.map((r) => r.external_id)).toEqual(['shared-a', 'shared-b'])
  })
})
