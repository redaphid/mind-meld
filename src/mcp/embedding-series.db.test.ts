import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const { getEmbeddingSeries } = await import('./embedding-series.js')

const row = (at: string, arrived: number, embedded: number, summarized: number) => ({
  at: new Date(at),
  arrived: String(arrived),
  embedded: String(embedded),
  summarized: String(summarized),
})

beforeEach(() => query.mockReset())

describe('getEmbeddingSeries', () => {
  it('maps counts out of their text form and keeps the spine intact', async () => {
    query.mockResolvedValue({
      rows: [
        row('2026-08-07T00:00:00Z', 10, 4, 0),
        row('2026-08-07T00:06:00Z', 0, 0, 0),
        row('2026-08-07T00:12:00Z', 3, 25, 2),
      ],
    })

    const series = await getEmbeddingSeries(360)

    expect(series.buckets).toHaveLength(3)
    expect(series.buckets[0]).toEqual({
      at: '2026-08-07T00:00:00.000Z',
      arrived: 10,
      embedded: 4,
      summarized: 0,
    })
    // COUNT() arrives as text; a string here would make the chart concatenate
    // rather than add.
    expect(typeof series.buckets[0].embedded).toBe('number')
  })

  it('totals and peaks each series independently', async () => {
    query.mockResolvedValue({
      rows: [
        row('2026-08-07T00:00:00Z', 10, 4, 0),
        row('2026-08-07T00:06:00Z', 1, 99, 1),
        row('2026-08-07T00:12:00Z', 3, 25, 2),
      ],
    })

    const series = await getEmbeddingSeries(360)

    expect(series.totals).toEqual({ arrived: 14, embedded: 128, summarized: 3 })
    // The peaks come from different buckets on purpose — a shared peak would
    // flatten the slow phase against the fast one.
    expect(series.peak).toEqual({ arrived: 10, embedded: 99, summarized: 2 })
  })

  it('reports the derived bucket size back, since the caller never picks it', async () => {
    query.mockResolvedValue({ rows: [] })
    const series = await getEmbeddingSeries(1440)
    expect(series.windowMinutes).toBe(1440)
    expect(series.bucketMinutes).toBe(24)
  })

  it('survives an empty window without dividing by zero', async () => {
    query.mockResolvedValue({ rows: [] })
    const series = await getEmbeddingSeries(60)
    expect(series.buckets).toEqual([])
    expect(series.totals).toEqual({ arrived: 0, embedded: 0, summarized: 0 })
    expect(series.peak).toEqual({ arrived: 0, embedded: 0, summarized: 0 })
  })

  it('passes the collection names as parameters rather than inlining them', async () => {
    query.mockResolvedValue({ rows: [] })
    await getEmbeddingSeries(60)
    const [, params] = query.mock.calls[0] as [string, string[]]
    expect(params).toContain('convo-messages')
    expect(params).toContain('convo-sessions')
  })
})
