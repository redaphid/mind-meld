import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))
vi.mock('../config.js', () => ({
  config: { machine: 'test-machine', logs: { retentionDays: 14 } },
}))

const { enqueue, flushLogs, sinkStats, startDbLogSink, __resetForTests } = await import(
  './db-sink.js'
)

const entry = (over: Partial<{ message: string; level: string }> = {}) => ({
  seq: 0,
  timestamp: '2026-08-02T00:00:00.000Z',
  level: (over.level ?? 'log') as 'log' | 'warn' | 'error',
  message: over.message ?? 'hello',
})

beforeEach(() => {
  query.mockReset()
  query.mockResolvedValue({ rows: [] })
  __resetForTests()
  startDbLogSink('sync')
})

describe('enqueue', () => {
  it('stamps the machine and service onto every entry', async () => {
    enqueue(entry({ message: 'a line' }))
    await flushLogs()

    const [, params] = query.mock.calls[0]
    expect(params[0]).toEqual(['test-machine'])
    expect(params[1]).toEqual(['sync'])
    expect(params[3]).toEqual(['a line'])
  })

  it('does not write synchronously — the line only lands on flush', () => {
    enqueue(entry())
    expect(query).not.toHaveBeenCalled()
    expect(sinkStats().pending).toBe(1)
  })

  it('drops the oldest entries once the queue cap is exceeded', () => {
    for (let i = 0; i < 5200; i++) enqueue(entry({ message: `line ${i}` }))

    const stats = sinkStats()
    expect(stats.pending).toBe(5000)
    expect(stats.droppedSinceStart).toBe(200)
  })
})

describe('flushLogs', () => {
  it('is a no-op when nothing is queued', async () => {
    await flushLogs()
    expect(query).not.toHaveBeenCalled()
  })

  it('batches large queues into multiple inserts', async () => {
    for (let i = 0; i < 600; i++) enqueue(entry({ message: `line ${i}` }))
    await flushLogs()

    // 600 entries at a 250 batch size = 3 inserts, plus the prune statement.
    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO logs'))
    expect(inserts).toHaveLength(3)
    expect(sinkStats().pending).toBe(0)
    expect(sinkStats().writtenSinceStart).toBe(600)
  })

  it('keeps entries queued for retry when the insert fails', async () => {
    query.mockRejectedValue(new Error('db down'))
    enqueue(entry())

    await flushLogs()

    expect(sinkStats().pending).toBe(1)
    expect(sinkStats().writtenSinceStart).toBe(0)
    expect(sinkStats().flushFailures).toBe(1)
  })

  it('does not throw when the database is unreachable', async () => {
    query.mockRejectedValue(new Error('db down'))
    enqueue(entry())

    await expect(flushLogs()).resolves.toBeUndefined()
  })

  it('recovers and writes the backlog once the database returns', async () => {
    query.mockRejectedValueOnce(new Error('db down'))
    enqueue(entry({ message: 'survives' }))
    await flushLogs()

    query.mockResolvedValue({ rows: [] })
    await flushLogs()

    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO logs'))
    expect(inserts[inserts.length - 1][1][3]).toEqual(['survives'])
    expect(sinkStats().pending).toBe(0)
  })

  it('prunes rows older than the retention window', async () => {
    enqueue(entry())
    await flushLogs()

    const prune = query.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM logs'))
    expect(prune).toBeDefined()
    expect(prune?.[1]).toEqual(['14'])
  })

  it('prunes at most once per interval even across many flushes', async () => {
    enqueue(entry())
    await flushLogs()
    enqueue(entry())
    await flushLogs()

    const prunes = query.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM logs'))
    expect(prunes).toHaveLength(1)
  })
})
