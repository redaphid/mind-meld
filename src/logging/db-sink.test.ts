import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))
vi.mock('../config.js', () => ({
  config: { machine: 'test-machine', logs: { retentionDays: 14 } },
}))

const { enqueue, flushLogs, exitFlush, sinkStats, startDbLogSink, __resetForTests } = await import(
  './db-sink.js'
)

const NUL = String.fromCharCode(0)

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

  // Postgres rejects U+0000 in text, and a rejected batch is retried forever:
  // one poisoned line would wedge the sink and eventually cost every later
  // line. The byte is escaped visibly at enqueue instead of eaten.
  it('escapes NUL bytes so one poisoned line cannot wedge the whole sink', async () => {
    enqueue(entry({ message: `saw wsl${NUL}--list${NUL} in a path` }))
    await flushLogs()

    const [, params] = query.mock.calls[0]
    expect(params[3]).toEqual(['saw wsl\\u0000--list\\u0000 in a path'])
    expect((params[3] as string[])[0]).not.toContain(NUL)
  })

  // A failing flush at shutdown used to re-fire beforeExit forever: the
  // process printed its summary and then never exited. The exit path gets a
  // bounded number of attempts, then reports and abandons the queue.
  it('exitFlush gives up after bounded consecutive failures instead of spinning forever', async () => {
    query.mockRejectedValue(new Error('invalid byte sequence for encoding "UTF8": 0x00'))
    enqueue(entry({ message: 'poisoned batch' }))

    await exitFlush()
    await exitFlush()
    await exitFlush()
    expect(sinkStats().pending).toBe(1) // still queued: three real attempts

    await exitFlush() // fourth: gives up, abandons the queue, counts the loss
    expect(sinkStats().pending).toBe(0)
    expect(sinkStats().droppedSinceStart).toBe(1)

    await exitFlush() // nothing left — must be a no-op, not another query
    expect(query).toHaveBeenCalledTimes(3)
  })

  // The bound is on consecutive failures, not lifetime cycles: a shutdown
  // where lines keep trickling in must not discard its tail while the
  // database is healthy.
  it('exitFlush resets its failure count once a flush succeeds', async () => {
    query.mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'))
    enqueue(entry({ message: 'first' }))
    await exitFlush()
    await exitFlush() // two consecutive failures banked
    await exitFlush() // third attempt succeeds and resets the count
    expect(sinkStats().pending).toBe(0)

    // A later outage gets a fresh three attempts, not the remainder of one.
    query.mockRejectedValue(new Error('down again'))
    enqueue(entry({ message: 'second' }))
    await exitFlush()
    await exitFlush()
    await exitFlush()
    expect(sinkStats().pending).toBe(1) // three real attempts, still queued
    await exitFlush() // now it gives up
    expect(sinkStats().pending).toBe(0)
  })

  // A cycle where the interval-driven flush already holds the latch attempts
  // no write, so it must not be charged as a failure.
  it('exitFlush does not burn an attempt on a flushing-latch collision', async () => {
    let release: (value: { rows: never[] }) => void = () => {}
    query.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    enqueue(entry({ message: 'slow line' }))

    const inflight = flushLogs() // acquires the latch and parks on the query
    await exitFlush() // collides with the latch — no attempt, no charge
    release({ rows: [] })
    await inflight

    expect(sinkStats().pending).toBe(0)
    // Only the in-flight flush ever wrote (a successful flush also prunes,
    // so count inserts, not calls).
    const inserts = query.mock.calls.filter(([sql]) =>
      (sql as string).includes('INSERT INTO logs')
    )
    expect(inserts).toHaveLength(1)
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
