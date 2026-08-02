import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The migration runner (src/db/migrations.ts) applies every init-db/*.sql via
// psql, so these assertions pin the contract of the file itself: idempotence,
// the fail-closed default, and the approved source→class mapping.
const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION = join(__dirname, '../../init-db/018-data-class.sql')

const sql = await readFile(MIGRATION, 'utf8')

// Collapse whitespace so assertions don't depend on formatting.
const flat = sql.replace(/\s+/g, ' ')

describe('migration 018-data-class', () => {
  it('is idempotent: guarded on the column not existing yet', () => {
    expect(flat).toContain("WHERE table_name = 'sources' AND column_name = 'data_class'")
    expect(flat).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM information_schema\.columns/i)
  })

  it('is additive only: no DROP, DELETE, or TRUNCATE', () => {
    expect(flat).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i)
  })

  it('fails closed: sources default to personal, NOT NULL', () => {
    expect(flat).toContain(
      "ALTER TABLE sources ADD COLUMN data_class VARCHAR(32) NOT NULL DEFAULT 'personal'"
    )
  })

  it('adds a nullable per-project override that inherits from the source', () => {
    expect(flat).toContain('ALTER TABLE projects ADD COLUMN data_class VARCHAR(32)')
    expect(flat).not.toMatch(/projects ADD COLUMN data_class VARCHAR\(32\) NOT NULL/)
  })

  it('maps claude_code and cursor to coding', () => {
    expect(flat).toContain(
      "UPDATE sources SET data_class = 'coding' WHERE name IN ('claude_code', 'cursor')"
    )
  })

  it('maps android to personal', () => {
    expect(flat).toContain("UPDATE sources SET data_class = 'personal' WHERE name = 'android'")
  })

  it('maps huddle to meetings', () => {
    expect(flat).toContain("UPDATE sources SET data_class = 'meetings' WHERE name = 'huddle'")
  })
})
