// Migrations are keyed by file name and applied in name order, so two files
// sharing a number apply in an order nobody chose. Caught here, at review.
import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { MIGRATIONS_DIR, MIGRATION_NAME } from './migrations.js'

// Already recorded under these names on deployed databases; renaming either
// would apply it a second time.
const GRANDFATHERED = new Set(['025-ingest-heads.sql', '025-semantic-switch.sql'])

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))

describe('init-db file names', () => {
  it('are all migration names the runner accepts', () => {
    expect(files.filter((f) => !MIGRATION_NAME.test(f))).toEqual([])
  })

  it('never share a number, apart from the pair already applied in production', () => {
    const seen = new Set([...GRANDFATHERED].map((f) => f.slice(0, 3)))
    const clashes: string[] = []
    for (const f of files.filter((name) => !GRANDFATHERED.has(name)).sort()) {
      if (seen.has(f.slice(0, 3))) clashes.push(f)
      seen.add(f.slice(0, 3))
    }
    expect(clashes).toEqual([])
  })
})
