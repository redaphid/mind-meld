// Migration 019 against fixture rows replicating every path pathology the
// live survey found (issue #33), plus proof that the runtime write path needs
// no caller-side normalization at all.
//
// Needs a reachable Postgres (the local dev stack on :5433). It builds a
// scratch database, applies the real init-db chain, seeds fixtures, runs 019
// through psql exactly as src/db/migrations.ts does, and asserts. In CI there
// is no database, so the whole suite skips — the pure normalization logic is
// covered by src/utils/project-path.test.ts either way.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import pg from 'pg'

const execAsync = promisify(exec)
const INIT_DB = resolve(dirname(fileURLToPath(import.meta.url)), '../../init-db')

const PG = {
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5433', 10),
  user: process.env.POSTGRES_USER ?? 'mindmeld',
  password: process.env.POSTGRES_PASSWORD ?? 'mindmeld',
}
const SCRATCH_DB = `mm_test_019_${randomBytes(4).toString('hex')}`

const canReachPostgres = async (): Promise<boolean> => {
  const client = new pg.Client({ ...PG, database: 'conversations', connectionTimeoutMillis: 1500 })
  try {
    await client.connect()
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const dbAvailable = await canReachPostgres()

// No ON_ERROR_STOP flag here — src/db/migrations.ts does not pass one either,
// and the historical chain only applies under that leniency (001's
// search_messages has a syntax error that 003 repairs). 019 protects itself:
// the file starts with `\set ON_ERROR_STOP on`, so ITS failures abort psql
// with a nonzero exit wherever it runs.
const psqlFile = async (database: string, file: string) => {
  await execAsync(
    `psql -h ${PG.host} -p ${PG.port} -U ${PG.user} -d ${database} -f "${file}"`,
    { env: { ...process.env, PGPASSWORD: PG.password } }
  )
}

let admin: pg.Client
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
  admin = new pg.Client({ ...PG, database: 'conversations' })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`)

  // The real migration chain, exactly as src/db/migrations.ts applies it —
  // everything before 019, so fixtures exist in the world 019 will meet.
  const files = (await readdir(INIT_DB)).filter((f) => f.endsWith('.sql') && f < '019').sort()
  for (const f of files) await psqlFile(SCRATCH_DB, join(INIT_DB, f))

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

  await psqlFile(SCRATCH_DB, join(INIT_DB, '019-canonical-project-paths.sql'))
}, 120_000)

afterAll(async () => {
  await db?.end().catch(() => {})
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`).catch(() => {})
    await admin.end().catch(() => {})
  }
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
    const survivor = await db.query(
      `SELECT p.id, p.path, count(s.id)::int AS sessions
       FROM projects p LEFT JOIN sessions s ON s.project_id = p.id
       WHERE p.external_id = 'D--tools-comfy'
       GROUP BY p.id, p.path`
    )
    expect(survivor.rows).toHaveLength(1)
    expect(survivor.rows[0].path).toBe('D:/tools/comfy')
    expect(survivor.rows[0].sessions).toBe(3) // 2 native + 1 adopted from WSL twin
  })

  it('merges drive-case duplicates', async () => {
    const rows = await db.query(
      `SELECT external_id FROM projects WHERE external_id IN ('D--projects', 'D--Projects')`
    )
    expect(rows.rows).toHaveLength(1)
  })

  it('loses no sessions and leaves distinct unix projects alone', async () => {
    const sessions = await db.query('SELECT count(*)::int AS n FROM sessions')
    expect(sessions.rows[0].n).toBe(12)
    expect(await pathOf('-home-alice-Projects-app')).toBe('/home/alice/Projects/app')
    expect(await pathOf('-home-bob-Projects-app')).toBe('/home/bob/Projects/app')
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
    const survivor = await db.query(`SELECT id FROM projects WHERE external_id = 'D--tools-comfy'`)
    const adoptedId = await queries.upsertProject(
      sourceId,
      '-mnt-d-tools-comfy',
      '-mnt-d-tools-comfy',
      '-mnt-d-tools-comfy'
    )
    expect(adoptedId).toBe(survivor.rows[0].id)
    const twins = await db.query(`SELECT id FROM projects WHERE external_id = '-mnt-d-tools-comfy'`)
    expect(twins.rows).toEqual([])
  })
})
