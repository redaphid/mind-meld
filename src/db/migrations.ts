import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const execFileAsync = promisify(execFile)
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../init-db')

type PgTarget = { host: string; port: number; user: string; password: string; database: string }

// The filename is written into SQL below, so only names of this shape are migrations.
export const MIGRATION_NAME = /^\d{3}-[a-z0-9-]+\.sql$/

const TRACKING_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  filename VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT now()
)`

export class MigrationError extends Error {
  constructor(readonly filename: string, readonly psqlOutput: string) {
    super(`Migration ${filename} failed and was rolled back; it is not recorded and no later migration ran.\n${psqlOutput}`)
    this.name = 'MigrationError'
  }
}

// One psql run, one transaction: the tracking table, the file, and the row that
// records it commit together or not at all. psql rather than the pg driver
// because migrations use psql meta-commands (019 sets ON_ERROR_STOP itself).
// No migration may open its own transaction or use CREATE INDEX CONCURRENTLY.
export const applyMigration = async (target: PgTarget, dir: string, filename: string): Promise<void> => {
  if (!MIGRATION_NAME.test(filename)) throw new Error(`Not a migration file name: ${filename}`)
  const args = [
    '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction',
    '-h', target.host, '-p', String(target.port), '-U', target.user, '-d', target.database,
    '-c', TRACKING_TABLE,
    '-f', join(dir, filename),
    '-c', `INSERT INTO schema_migrations (filename) VALUES ('${filename}')`,
  ]
  try {
    await execFileAsync('psql', args, { env: { ...process.env, PGPASSWORD: target.password } })
  } catch (error) {
    const e = error as { stderr?: string; message: string }
    throw new MigrationError(filename, e.stderr?.trim() || e.message)
  }
}

const appliedMigrations = async (target: PgTarget): Promise<Set<string>> => {
  const client = new pg.Client(target)
  await client.connect()
  try {
    await client.query(TRACKING_TABLE)
    const { rows } = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')
    return new Set(rows.map(r => r.filename))
  } finally {
    await client.end()
  }
}

export const runMigrations = async (target: PgTarget, dir = MIGRATIONS_DIR): Promise<string[]> => {
  const applied = await appliedMigrations(target)
  const pending = (await readdir(dir)).filter(f => f.endsWith('.sql') && !applied.has(f)).sort()
  for (const filename of pending) {
    console.log(`Applying migration: ${filename}`)
    await applyMigration(target, dir, filename)
    console.log(`Applied: ${filename}`)
  }
  console.log(pending.length ? `Migrations complete: ${pending.length} applied` : 'Migrations complete: none pending')
  return pending
}
