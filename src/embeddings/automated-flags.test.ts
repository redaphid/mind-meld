import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query }))

const { correctAutomatedDrift } = await import('./automated-flags.js')

beforeEach(() => query.mockReset())

// The behavior against a real table, including a repeated correction changing
// nothing, is in automated-flags.db.test.ts.
describe('correctAutomatedDrift', () => {
  it('writes nothing when nothing drifted', async () => {
    expect(await correctAutomatedDrift([])).toBe(0)
    expect(query).not.toHaveBeenCalled()
  })

  it('flips each session from the flag it was read with, in one statement', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 2 })
    const changed = await correctAutomatedDrift([
      { id: 7, source: 'claude_code', machine: null, stored: false },
      { id: 9, source: 'codex', machine: null, stored: true },
    ])

    expect(changed).toBe(2)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][1]).toEqual([[7, 9], [false, true]])
  })
})
