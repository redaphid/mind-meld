import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const { usageStats, formatUsageStats, toUsageStats, VECTOR_PARAMS, STAGES } = await import('./usage-stats.js')

const row = (over: Record<string, unknown> = {}) => ({
  searches: 10, ok: 8, opened: 4, ranked: 3, median_rank: 2, mrr: 0.611, no_result: 2, degraded: 1,
  p50: 14.2, p90: 51.7, feedback: 3, per_day: [],
  vector_params: { negativeQuery: 2, likeSession: 1, unlikeSession: 0, likeProject: 0, unlikeProject: 0 },
  stage_ms: {
    semanticMs: { p50: 9, p90: 30 }, embedMs: { p50: 6, p90: 25.4 }, sessionMs: { p50: 2, p90: 4 },
    chunkMs: { p50: 2, p90: 5 }, messageMs: { p50: 3, p90: 6 }, fullTextMs: { p50: null, p90: null },
  },
  ...over,
})

describe('usage stats', () => {
  beforeEach(() => query.mockReset())

  it('turns counts into rates over searches that did not throw', () => {
    const s = toUsageStats(7, row() as never)
    expect(s).toMatchObject({
      days: 7, searches: 10, openedShare: 0.5, noResultRate: 0.25, degradedRate: 0.125,
      feedbackPerSearch: 0.375, openedRank: { opens: 3, median: 2, mrr: 0.611 }, latencyMs: { p50: 14.2, p90: 51.7 },
    })
  })

  it('reports no rate, rather than zero, for a window with no searches', () => {
    const s = toUsageStats(7, row({ searches: 0, ok: 0, opened: 0, no_result: 0, degraded: 0, feedback: 0 }) as never)
    expect([s.openedShare, s.noResultRate, s.degradedRate, s.feedbackPerSearch]).toEqual([null, null, null, null])
  })

  it('sends the window, the excluded clients, the open window and the parameter keys', async () => {
    query.mockResolvedValueOnce({ rows: [row()] })
    await usageStats(30)
    const [, params] = query.mock.calls[0]
    expect(params).toEqual([30, ['bench', 'eval'], 10, JSON.stringify(VECTOR_PARAMS), STAGES])
    expect(STAGES).toEqual(['semanticMs', 'embedMs', 'sessionMs', 'chunkMs', 'messageMs', 'fullTextMs'])
  })

  it('renders one column per window and the per-day breakdown of the first', () => {
    const week = toUsageStats(7, row({ per_day: [{ day: '2026-11-12', client: 'web-ui', mode: 'text', searches: 3 }] }) as never)
    const month = toUsageStats(30, row({ searches: 0, ok: 0, p50: null, p90: null, median_rank: null, mrr: null }) as never)
    const out = formatUsageStats([week, month])
    expect(out).toContain('| | 7d | 30d |')
    expect(out).toContain('| Opened within 10 min | 50.0% | n/a |')
    expect(out).toContain('| Latency p50 ms | 14 | n/a |')
    expect(out).toContain('| embed p50 / p90 ms | 6 / 25 | 6 / 25 |')
    expect(out).toContain('| fullText p50 / p90 ms | n/a / n/a | n/a / n/a |')
    expect(out).toContain('| Uses negativeQuery | 2 | 2 |')
    expect(out).toContain('- 2026-11-12 web-ui text: 3')
    expect(formatUsageStats([month])).toContain('No searches.')
  })
})
