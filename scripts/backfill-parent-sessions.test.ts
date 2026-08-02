import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('../src/db/postgres.js', () => ({
  query: queryMock,
  closePool: vi.fn(),
}))

const { applyLinks, revertFromJournal } = await import('./backfill-parent-sessions.js')

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 })
})

const planned = (over: Record<string, unknown> = {}) => ({
  id: 4280,
  externalId: 'agent-a',
  parentId: 3182,
  parentExternalId: 'sess-1',
  previousParentSessionId: null,
  ...over,
})

describe('applyLinks', () => {
  // The journal used to hardcode previousParentSessionId: null, which was only
  // ever right by inference from the plan-time filter. Read values are carried
  // through instead, so the journal describes the database rather than an
  // assumption about it (#48 review, finding 3).
  it('journals the previous value read from the row, not an assumed null', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 4280 }], rowCount: 1 })

    const { journal } = await applyLinks([planned({ previousParentSessionId: 999 })])

    expect(journal).toEqual([
      { id: 4280, previousParentSessionId: 999, wroteParentSessionId: 3182 },
    ])
  })

  // The guarded UPDATE correctly skips a row that a concurrent sync linked
  // between plan and apply. That skip has to be reported, not folded into a
  // success count -- the old code reported rowCount and the operator could not
  // tell the difference.
  it('separates rows it actually wrote from rows a concurrent sync had already linked', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 4280 }], rowCount: 1 })
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const { written, skipped } = await applyLinks([
      planned({ id: 4280 }),
      planned({ id: 4281, externalId: 'agent-b' }),
    ])

    expect(written.map((w) => w.id)).toEqual([4280])
    expect(skipped.map((s) => s.id)).toEqual([4281])
  })

  it('only ever writes where the link is still null', async () => {
    await applyLinks([planned()])
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('parent_session_id IS NULL')
    expect(params).toEqual([4280, 3182])
  })
})

describe('revertFromJournal', () => {
  // The failure this exists to prevent: sync links a row between plan and
  // apply, the guarded UPDATE skips it, the row is nonetheless in the journal,
  // and a later revert NULLs out a correct link the script never wrote. The
  // revert has to prove it is undoing its own write before undoing anything.
  it('restores only rows still holding the value the backfill wrote', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 4280 }], rowCount: 1 })

    await revertFromJournal([
      { id: 4280, previousParentSessionId: null, wroteParentSessionId: 3182 },
    ])

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('parent_session_id IS NOT DISTINCT FROM $3')
    expect(params).toEqual([4280, null, 3182])
  })

  it('reports a row it did not restore instead of counting it as reverted', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 })

    const result = await revertFromJournal([
      { id: 4281, previousParentSessionId: null, wroteParentSessionId: 3182 },
    ])

    expect(result.reverted).toEqual([])
    expect(result.untouched).toEqual([4281])
  })

  // A journal from the old format has no wroteParentSessionId. Reverting it
  // unguarded is exactly the destructive behaviour being fixed, so it is
  // refused outright rather than best-efforted.
  it('refuses a journal entry with no recorded written value', async () => {
    await expect(
      revertFromJournal([{ id: 4281, previousParentSessionId: null } as never])
    ).rejects.toThrow(/wroteParentSessionId/)
    expect(queryMock).not.toHaveBeenCalled()
  })
})
