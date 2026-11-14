// A throwaway database for tests that need real PostgreSQL: created on the
// configured server, built from the real init-db chain, dropped afterwards.
//
// Tests skip when no server is reachable, or when the `psql` binary is missing:
// the chain is applied through psql exactly as src/db/migrations.ts applies it.
// Set REQUIRE_DATABASE=1 where a database is supposed to exist (the CI job that
// provides one), and a missing one fails instead of skipping quietly.
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import pg from 'pg'

const execAsync = promisify(exec)
export const INIT_DB = resolve(dirname(fileURLToPath(import.meta.url)), '../../init-db')

export const PG = {
  host: process.env.POSTGRES_HOST ?? '127.0.0.1',
  port: parseInt(process.env.POSTGRES_PORT ?? '5433', 10),
  user: process.env.POSTGRES_USER ?? 'mindmeld',
  password: process.env.POSTGRES_PASSWORD ?? 'mindmeld',
}

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

// A reachable server is not enough: where the database is up but psql is not
// installed (a Windows dev box, for one), probing only connectivity made suites
// hard-fail with `'psql' is not recognized` instead of skipping.
const hasPsqlBinary = async (): Promise<boolean> => {
  try {
    await execAsync('psql --version')
    return true
  } catch {
    return false
  }
}

export const dbAvailable = (await canReachPostgres()) && (await hasPsqlBinary())
if (!dbAvailable && process.env.REQUIRE_DATABASE === '1')
  throw new Error(`REQUIRE_DATABASE=1 but no PostgreSQL with psql at ${PG.host}:${PG.port}`)

// No ON_ERROR_STOP flag here: src/db/migrations.ts does not pass one either,
// and the historical chain only applies under that leniency (001's
// search_messages has a syntax error that 003 repairs).
export const psqlFile = async (database: string, file: string) => {
  await execAsync(`psql -h ${PG.host} -p ${PG.port} -U ${PG.user} -d ${database} -f "${file}"`, {
    env: { ...process.env, PGPASSWORD: PG.password },
  })
}

export const initDbFiles = async (keep: (file: string) => boolean = () => true) =>
  (await readdir(INIT_DB)).filter((f) => f.endsWith('.sql') && keep(f)).sort()

// Creates an empty database and returns its name with a way to drop it.
export const createScratchDatabase = async (prefix: string) => {
  const name = `${prefix}_${randomBytes(4).toString('hex')}`
  const admin = new pg.Client({ ...PG, database: 'conversations' })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  const drop = async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {})
    await admin.end().catch(() => {})
  }
  return { name, drop }
}

export const applyInitDb = async (database: string, keep?: (file: string) => boolean) => {
  for (const f of await initDbFiles(keep)) await psqlFile(database, join(INIT_DB, f))
}
