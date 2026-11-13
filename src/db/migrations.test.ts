// The migration runner against a real Postgres through the real psql binary.
// Needs both (the local dev stack, or any Postgres named by POSTGRES_*); where
// either is missing the suite skips, as src/db/migration-019.test.ts does.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { runMigrations, MigrationError, MIGRATIONS_DIR } from './migrations.js'

const PG = {
  host: process.env.POSTGRES_HOST ?? '127.0.0.1',
  port: parseInt(process.env.POSTGRES_PORT ?? '5433', 10),
  user: process.env.POSTGRES_USER ?? 'mindmeld',
  password: process.env.POSTGRES_PASSWORD ?? 'mindmeld',
}

const reachable = async (): Promise<boolean> => {
  const client = new pg.Client({ ...PG, database: 'postgres', connectionTimeoutMillis: 1500 })
  try {
    await client.connect()
    await promisify(execFile)('psql', ['--version'])
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}

const dbAvailable = await reachable()

const withScratchDb = () => {
  const database = `mm_test_migrate_${randomBytes(4).toString('hex')}`
  const admin = new pg.Client({ ...PG, database: 'postgres' })
  const target = { ...PG, database }
  const sql = async (text: string) => {
    const c = new pg.Client(target)
    await c.connect()
    try {
      return (await c.query(text)).rows
    } finally {
      await c.end()
    }
  }
  beforeAll(async () => {
    await admin.connect()
    await admin.query(`CREATE DATABASE ${database}`)
  }, 60_000)
  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {})
    await admin.end().catch(() => {})
  }, 60_000)
  return { target, sql }
}

const tables = (rows: { tablename: string }[]) => rows.map(r => r.tablename).sort()

describe.skipIf(!dbAvailable)('runMigrations stops at the first failure', () => {
  const { target, sql } = withScratchDb()
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mm-migrations-'))
    await writeFile(join(dir, '001-good.sql'), 'CREATE TABLE first_table (id int);')
    await writeFile(join(dir, '002-broken.sql'), 'CREATE TABLE half_table (id int);\nSELECT * FROM no_such_table;\n')
    await writeFile(join(dir, '003-after.sql'), 'CREATE TABLE after_table (id int);')
  })
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('rolls the broken file back, does not record it, and runs nothing after it', async () => {
    const run = runMigrations(target, dir)
    await expect(run).rejects.toBeInstanceOf(MigrationError)
    await expect(run).rejects.toThrow(/002-broken\.sql[\s\S]*no_such_table/)

    const recorded = await sql('SELECT filename FROM schema_migrations ORDER BY filename')
    expect(recorded.map(r => r.filename)).toEqual(['001-good.sql'])
    const present = await sql(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)
    expect(tables(present as { tablename: string }[])).toEqual(['first_table', 'schema_migrations'])
  })

  it('resumes from the repaired file on the next run', async () => {
    await writeFile(join(dir, '002-broken.sql'), 'CREATE TABLE half_table (id int);')
    expect(await runMigrations(target, dir)).toEqual(['002-broken.sql', '003-after.sql'])
    expect(await runMigrations(target, dir)).toEqual([])
  })
})

describe.skipIf(!dbAvailable)('the real init-db chain under the strict runner', () => {
  const { target, sql } = withScratchDb()

  it('applies every file to an empty database and records each one', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort()
    expect(await runMigrations(target)).toEqual(files)
    const recorded = await sql('SELECT filename FROM schema_migrations ORDER BY filename')
    expect(recorded.map(r => r.filename)).toEqual(files)
    const fns = await sql(`SELECT proname FROM pg_proc WHERE proname IN ('search_messages', 'get_session_with_messages') ORDER BY 1`)
    expect(fns.map(r => r.proname)).toEqual(['get_session_with_messages', 'search_messages'])
  }, 120_000)
})
