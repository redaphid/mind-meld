import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const { getSummaryStatus } = await import('./summary-status.js')

// getSummaryStatus fires five queries concurrently, in a fixed order:
// totals, pending, oldest, recent, active.
const respondWith = (
  over: Partial<{
    totals: unknown
    pending: unknown
    oldest: unknown
    recent: unknown
    active: unknown
  }> = {}
) => {
  const answers = [
    over.totals ?? { rows: [{ total: '1172', summarized: '713' }] },
    over.pending ?? { rows: [{ count: '460' }] },
    over.oldest ?? { rows: [{ started_at: new Date('2026-01-02T03:04:05Z') }] },
    over.recent ?? { rows: [] },
    over.active ?? { rows: [] },
  ]
  let i = 0
  query.mockImplementation(() => Promise.resolve(answers[i++]))
}

beforeEach(() => query.mockReset())

describe('getSummaryStatus', () => {
  it('reports session totals and the pending count as numbers', async () => {
    respondWith()
    const s = await getSummaryStatus()
    expect(s.sessions).toEqual({ total: 1172, summarized: 713, pending: 460 })
  })

  it('names the model actually configured for summarizing', async () => {
    respondWith()
    const s = await getSummaryStatus()
    expect(s.model).toBe('qwen3:4b-instruct')
  })

  it('expresses how far behind the queue is as a date, not a count', async () => {
    respondWith()
    const s = await getSummaryStatus()
    expect(s.oldestPendingStartedAt).toBe('2026-01-02T03:04:05.000Z')
  })

  it('has no oldest date when nothing is pending', async () => {
    respondWith({ oldest: { rows: [] } })
    const s = await getSummaryStatus()
    expect(s.oldestPendingStartedAt).toBeNull()
  })

  // The duplicate-work signal. The queue is global and unclaimed, so two
  // workers on one session is a real, observed state — and the count is the
  // only place it becomes visible.
  it('surfaces how many distinct workers are on each active session', async () => {
    respondWith({
      active: {
        rows: [
          {
            sess: '4840',
            chunk_passes: '16',
            workers: '2',
            last_at: new Date('2026-08-07T05:42:40Z'),
          },
        ],
      },
    })
    const s = await getSummaryStatus()
    expect(s.active).toEqual([
      {
        sessionId: 4840,
        chunkPasses: 16,
        workers: 2,
        lastAt: '2026-08-07T05:42:40.000Z',
      },
    ])
  })

  it('keeps a null title rather than inventing one', async () => {
    respondWith({
      recent: { rows: [{ id: 5630, title: null, created_at: new Date('2026-08-07T05:22:04Z') }] },
    })
    const s = await getSummaryStatus()
    expect(s.recent).toEqual([{ id: 5630, title: null, at: '2026-08-07T05:22:04.000Z' }])
  })

  // Session embeddings carry no session_id column — they are keyed
  // `session-<id>` in chroma_id. Joining through message_id would attribute the
  // summary to the wrong row entirely.
  it('joins recent summaries through chroma_id, not message_id', async () => {
    respondWith()
    await getSummaryStatus()
    const recentSql = String((query.mock.calls[3] as [string])[0])
    expect(recentSql).toContain('chroma_id')
    expect(recentSql).not.toContain('e.session_id')
  })
})
