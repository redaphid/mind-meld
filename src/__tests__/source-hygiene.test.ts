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

  // Widened past 0x00 on purpose. The first fix for this swapped the NUL for a
  // raw 0x1f, which git does not call binary but which is just as invisible to
  // a human reading the diff -- the separator simply vanishes and the key looks
  // like plain concatenation. Any C0 control byte other than tab, newline and
  // carriage return is a bug or an invisible surprise; the \uXXXX escape reads
  // identically and survives review.
  it('has no raw control characters in any TypeScript source, so every file reviews as text', async () => {
    const files = (await Promise.all(roots.map(walk))).flat()
    expect(files.length).toBeGreaterThan(0)

    const allowed = new Set([0x09, 0x0a, 0x0d])
    const offenders: string[] = []
    for (const file of files) {
      const bytes = await readFile(file)
      const at = bytes.findIndex((b) => b < 0x20 && !allowed.has(b))
      if (at !== -1)
        offenders.push(`${file} (0x${bytes[at].toString(16).padStart(2, '0')} at byte ${at})`)
    }

    expect(offenders).toEqual([])
  })
})
