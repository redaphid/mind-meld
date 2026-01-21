import { exec } from 'child_process'
import { promisify } from 'util'
import { query } from './postgres.js'
import { readdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from '../config.js'

const execAsync = promisify(exec)
const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '../../init-db')

export const runMigrations = async (): Promise<void> => {
  // Create migrations tracking table if it doesn't exist
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    )
  `)

  // Get list of migration files
  const files = await readdir(MIGRATIONS_DIR)
  const sqlFiles = files.filter(f => f.endsWith('.sql')).sort()

  for (const filename of sqlFiles) {
    // Check if already applied
    const result = await query<{ filename: string }>(
      'SELECT filename FROM schema_migrations WHERE filename = $1',
      [filename]
    )

    if (result.rows.length > 0) {
      console.log(`Migration already applied: ${filename}`)
      continue
    }

    console.log(`Applying migration: ${filename}`)
    const filePath = join(MIGRATIONS_DIR, filename)

    try {
      // Use psql for PL/pgSQL compatibility
      const { host, port, user, password, database } = config.postgres
      const env = { ...process.env, PGPASSWORD: password }
      await execAsync(
        `psql -h ${host} -p ${port} -U ${user} -d ${database} -f "${filePath}"`,
        { env }
      )

      await query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [filename]
      )
      console.log(`Applied: ${filename}`)
    } catch (error) {
      console.error(`Failed to apply migration ${filename}:`, error)
      throw error
    }
  }

  console.log('Migrations complete')
}
