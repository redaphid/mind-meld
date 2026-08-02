import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const { readStoredLogs, countStoredLogs, getLogWriters } = await import('./stored-logs.js')

beforeEach(() => {
  query.mockReset()
  query.mockResolvedValue({ rows: [] })
})

const sqlOf = (call: number) => String(query.mock.calls[call][0])
const paramsOf = (call: number) => query.mock.calls[call][1]

describe('readStoredLogs', () => {
  it('reads across all machines when no filter is given', async () => {
    await readStoredLogs({ limit: 10, offset: 0 })

    expect(sqlOf(0)).not.toContain('WHERE')
    expect(paramsOf(0)).toEqual([10, 0])
  })

  it('orders newest first', async () => {
    await readStoredLogs({ limit: 10, offset: 0 })
    expect(sqlOf(0)).toContain('ORDER BY logged_at DESC, id DESC')
  })

  it('numbers placeholders correctly when filters are combined', async () => {
    await readStoredLogs({ limit: 25, offset: 50, machine: 'survivor', level: 'error' })

    const sql = sqlOf(0)
    expect(sql).toContain('machine = $1')
    expect(sql).toContain('level = $2')
    expect(sql).toContain('LIMIT $3 OFFSET $4')
    expect(paramsOf(0)).toEqual(['survivor', 'error', 25, 50])
  })

  it('wraps a contains filter in wildcards for a substring match', async () => {
    await readStoredLogs({ limit: 10, offset: 0, contains: 'boom' })

    expect(sqlOf(0)).toContain('message ILIKE $1')
    expect(paramsOf(0)).toEqual(['%boom%', 10, 0])
  })

  it('returns messages whole rather than clipped', async () => {
    const message = 'M'.repeat(40_000)
    query.mockResolvedValue({
      rows: [
        {
          id: '1',
          machine: 'windows',
          service: 'sync',
          level: 'log',
          message,
          logged_at: '2026-08-02T00:00:00.000Z',
        },
      ],
    })

    const [row] = await readStoredLogs({ limit: 1, offset: 0 })
    expect(row.message).toHaveLength(40_000)
    expect(row.id).toBe('1')
  })
})

describe('countStoredLogs', () => {
  it('applies the same filters as the page query, without limit or offset', async () => {
    await countStoredLogs({ limit: 10, offset: 0, machine: 'soul' })

    expect(sqlOf(0)).toContain('COUNT(*)')
    expect(sqlOf(0)).toContain('machine = $1')
    expect(paramsOf(0)).toEqual(['soul'])
  })

  it('coerces the count string to a number', async () => {
    query.mockResolvedValue({ rows: [{ count: '4321' }] })
    expect(await countStoredLogs({ limit: 10, offset: 0 })).toBe(4321)
  })

  it('reports zero when the table is empty', async () => {
    query.mockResolvedValue({ rows: [] })
    expect(await countStoredLogs({ limit: 10, offset: 0 })).toBe(0)
  })
})

describe('getLogWriters', () => {
  it('groups by machine and service so shared machines stay distinguishable', async () => {
    query.mockResolvedValue({
      rows: [
        { machine: 'windows', service: 'sync', entries: '1799', last_logged_at: '2026-08-02T00:00:00.000Z' },
        { machine: 'windows', service: 'mcp', entries: '114', last_logged_at: '2026-08-01T23:00:00.000Z' },
      ],
    })

    const writers = await getLogWriters()
    expect(writers).toHaveLength(2)
    expect(writers[0]).toEqual({
      machine: 'windows',
      service: 'sync',
      entries: 1799,
      lastLoggedAt: '2026-08-02T00:00:00.000Z',
    })
    expect(sqlOf(0)).toContain('GROUP BY machine, service')
  })
})
