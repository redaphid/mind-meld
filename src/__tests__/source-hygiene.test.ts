import { describe, it, expect } from 'vitest'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

// A raw 0x00 byte in a source file makes git classify that file as BINARY, so
// it renders with no diff in the PR UI. That is how scripts/backfill-parent-
// sessions.ts — a script asking the operator to approve a 187-row mutation of
// the live index — reached review as an unreviewable blob (#48 review,
// finding 4). The escape sequence is identical to read and keeps the file
// diffable, so there is never a reason to embed the byte directly.
//
// Postgres rejects these bytes in data too ('invalid byte sequence for
// encoding "UTF8": 0x00'), which is why the codebase already scrubs them from
// message content — the same byte should not be in the source doing the
// scrubbing.
describe('source hygiene', () => {
  const roots = ['src', 'scripts']

  const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true })
    const found: string[] = []
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) found.push(...(await walk(full)))
      else if (entry.isFile() && /\.(ts|mjs|js)$/.test(entry.name)) found.push(full)
    }
    return found
  }

  it('has no raw NUL bytes in any TypeScript source, so every file diffs as text', async () => {
    const files = (await Promise.all(roots.map(walk))).flat()
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const bytes = await readFile(file)
      const at = bytes.indexOf(0)
      if (at !== -1) offenders.push(`${file} (first at byte ${at})`)
    }

    expect(offenders).toEqual([])
  })
})
