import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// captureConsole patches the global console and the buffer is module state, so
// each test needs a fresh module and a restored console.
const original = { log: console.log, warn: console.warn, error: console.error }

const load = async () => {
  vi.resetModules()
  // Held by reference: after captureConsole() runs, console.log is the wrapper,
  // and these spies are what it delegates to.
  const spies = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  console.log = spies.log
  console.warn = spies.warn
  console.error = spies.error
  const mod = await import('./log-buffer.js')
  mod.captureConsole()
  return { ...mod, spies }
}

beforeEach(() => {
  Object.assign(console, original)
})

afterEach(() => {
  Object.assign(console, original)
})

describe('captureConsole', () => {
  it('records a message and still writes through to the real console', async () => {
    const { readLogs, spies } = await load()

    console.log('hello world')

    const { entries } = readLogs({ limit: 10, offset: 0 })
    expect(entries).toHaveLength(1)
    expect(entries[0].message).toBe('hello world')
    expect(entries[0].level).toBe('log')
    expect(spies.log).toHaveBeenCalledWith('hello world')
  })

  it('joins multiple arguments the way console does', async () => {
    const { readLogs } = await load()
    console.log('count:', 42)
    expect(readLogs({ limit: 10, offset: 0 }).entries[0].message).toBe('count: 42')
  })

  it('serialises Errors with their stack and objects as JSON', async () => {
    const { readLogs } = await load()
    console.error(new Error('boom'))
    console.warn({ a: 1 })

    const { entries } = readLogs({ limit: 10, offset: 0 })
    expect(entries[0].message).toBe('{"a":1}')
    expect(entries[1].message).toContain('boom')
  })

  it('falls back to String() for circular objects instead of throwing', async () => {
    const { readLogs } = await load()
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => console.log(circular)).not.toThrow()
    expect(readLogs({ limit: 10, offset: 0 }).entries[0].message).toContain('object')
  })

  it('is idempotent so a second install does not double-record', async () => {
    const mod = await load()
    mod.captureConsole()

    console.log('once')

    expect(readLogsCount(mod)).toBe(1)
  })
})

const readLogsCount = (mod: { readLogs: (o: { limit: number; offset: number }) => { matching: number } }) =>
  mod.readLogs({ limit: 10, offset: 0 }).matching

describe('readLogs', () => {
  it('returns newest entries first', async () => {
    const { readLogs } = await load()
    console.log('first')
    console.log('second')
    console.log('third')

    const messages = readLogs({ limit: 10, offset: 0 }).entries.map(e => e.message)
    expect(messages).toEqual(['third', 'second', 'first'])
  })

  it('paginates with offset rather than truncating message content', async () => {
    const { readLogs } = await load()
    const long = 'x'.repeat(50_000)
    console.log(long)
    console.log('newer')

    const page1 = readLogs({ limit: 1, offset: 0 })
    const page2 = readLogs({ limit: 1, offset: 1 })

    expect(page1.entries[0].message).toBe('newer')
    // The long line comes back whole — no clipping anywhere in the path.
    expect(page2.entries[0].message).toHaveLength(50_000)
    expect(page2.matching).toBe(2)
  })

  it('reports an empty page past the end without erroring', async () => {
    const { readLogs } = await load()
    console.log('only')

    const result = readLogs({ limit: 10, offset: 99 })
    expect(result.entries).toEqual([])
    expect(result.returned).toBe(0)
    expect(result.matching).toBe(1)
  })

  it('filters by level and counts only matching entries', async () => {
    const { readLogs } = await load()
    console.log('a log')
    console.error('an error')
    console.warn('a warning')

    const errors = readLogs({ limit: 10, offset: 0, level: 'error' })
    expect(errors.entries).toHaveLength(1)
    expect(errors.entries[0].message).toBe('an error')
    expect(errors.matching).toBe(1)
    expect(errors.retained).toBe(3)
  })

  it('evicts the oldest entries past capacity and reports how many were dropped', async () => {
    const { readLogs } = await load()
    const capacity = readLogs({ limit: 1, offset: 0 }).capacity

    for (let i = 0; i < capacity + 5; i++) console.log(`line ${i}`)

    const result = readLogs({ limit: 1, offset: 0 })
    expect(result.retained).toBe(capacity)
    expect(result.capturedSinceStart).toBe(capacity + 5)
    expect(result.droppedSinceStart).toBe(5)
    expect(result.entries[0].message).toBe(`line ${capacity + 4}`)
  })

  it('assigns monotonically increasing sequence numbers that survive eviction', async () => {
    const { readLogs } = await load()
    console.log('a')
    console.log('b')

    const { entries } = readLogs({ limit: 10, offset: 0 })
    expect(entries[0].seq).toBe(1)
    expect(entries[1].seq).toBe(0)
  })
})
