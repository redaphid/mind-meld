import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../db/postgres.js', () => ({ query: vi.fn() }))

import { query } from '../db/postgres.js'
import {
  summarizeThroughput,
  clampWindow,
  getThroughput,
  DEFAULT_WINDOW_MINUTES,
} from './throughput.js'

const NOW = new Date('2026-08-02T12:00:00.000Z')

const report = (over: Partial<Parameters<typeof summarizeThroughput>[0]> = {}) =>
  summarizeThroughput({
    pending: 1000,
    embeddedTotal: 50_000,
    embeddedInWindow: 600,
    arrivedInWindow: 0,
    windowMinutes: 60,
    now: NOW,
    ...over,
  })

// The whole point of this endpoint is telling "working through it" apart from
// "stopped" apart from "losing ground" — three situations a single pending
// count renders identically.
describe('summarizeThroughput', () => {
  describe('when the queue is being worked off', () => {
    it('reports draining with the net rate', () => {
      const r = report({ embeddedInWindow: 600, arrivedInWindow: 60 })
      expect(r.state).toBe('draining')
      expect(r.rates.embeddedPerMinute).toBe(10)
      expect(r.rates.arrivedPerMinute).toBe(1)
      expect(r.rates.netDrainPerMinute).toBe(9)
    })

    it('projects a finish time from the NET rate, not the gross one', () => {
      // 1000 pending draining at 9/min is ~111 min. Using the gross 10/min
      // would promise 100 min and quietly never arrive.
      const r = report({ embeddedInWindow: 600, arrivedInWindow: 60 })
      expect(r.eta.secondsRemaining).toBe(Math.round((1000 / 9) * 60))
      expect(r.eta.finishesAt).toBe(
        new Date(NOW.getTime() + Math.round((1000 / 9) * 60) * 1000).toISOString()
      )
    })
  })

  describe('when nothing is being embedded but a backlog exists', () => {
    const r = report({ embeddedInWindow: 0, arrivedInWindow: 30 })

    it('reports stalled rather than a rate of zero', () => {
      expect(r.state).toBe('stalled')
    })

    it('offers no ETA', () => {
      expect(r.eta.secondsRemaining).toBeNull()
      expect(r.eta.finishesAt).toBeNull()
    })
  })

  describe('when messages arrive faster than they are embedded', () => {
    const r = report({ embeddedInWindow: 60, arrivedInWindow: 600 })

    it('reports falling-behind', () => {
      expect(r.state).toBe('falling-behind')
      expect(r.rates.netDrainPerMinute).toBe(-9)
    })

    // An ETA from a negative drain rate is a negative duration. Printing that
    // as a finish time is worse than saying there is not one.
    it('refuses to invent an ETA', () => {
      expect(r.eta.secondsRemaining).toBeNull()
      expect(r.eta.finishesAt).toBeNull()
    })
  })

  describe('when arrival exactly matches throughput', () => {
    const r = report({ embeddedInWindow: 300, arrivedInWindow: 300 })

    it('reports holding, and still gives no ETA', () => {
      expect(r.state).toBe('holding')
      expect(r.rates.netDrainPerMinute).toBe(0)
      expect(r.eta.secondsRemaining).toBeNull()
    })
  })

  describe('when there is nothing left to embed', () => {
    const r = report({ pending: 0, embeddedInWindow: 0, arrivedInWindow: 0 })

    it('reports caught-up with zero remaining', () => {
      expect(r.state).toBe('caught-up')
      expect(r.eta.secondsRemaining).toBe(0)
    })
  })

  it('echoes the window it measured so a rate is never read bare', () => {
    const r = report({ windowMinutes: 15, embeddedInWindow: 150 })
    expect(r.window).toEqual({ minutes: 15, embedded: 150, arrived: 0 })
    expect(r.rates.embeddedPerMinute).toBe(10)
  })
})

describe('clampWindow', () => {
  it('defaults when the caller sends nothing usable', () => {
    expect(clampWindow(undefined)).toBe(DEFAULT_WINDOW_MINUTES)
    expect(clampWindow('')).toBe(DEFAULT_WINDOW_MINUTES)
    expect(clampWindow('soon')).toBe(DEFAULT_WINDOW_MINUTES)
  })

  it('accepts a query string number', () => {
    expect(clampWindow('15')).toBe(15)
  })

  it('holds the window inside a range where a rate still means something', () => {
    expect(clampWindow(0)).toBe(1)
    expect(clampWindow(-30)).toBe(1)
    expect(clampWindow(100_000)).toBe(1440)
  })
})

// Postgres returns COUNT(*) as a string, and the four counts are read
// positionally — swap two and the dashboard reports a confident, wrong ETA.
describe('getThroughput', () => {
  const counts = (...values: string[]) => {
    const mocked = vi.mocked(query)
    for (const count of values) mocked.mockResolvedValueOnce({ rows: [{ count }] } as any)
  }

  beforeEach(() => {
    vi.mocked(query).mockReset()
  })

  it('maps pending, total, embedded-in-window and arrived-in-window in that order', async () => {
    counts('500', '9000', '300', '60')

    const r = await getThroughput(60)

    expect(r.queue).toEqual({ pending: 500, embedded: 9000 })
    expect(r.window).toEqual({ minutes: 60, embedded: 300, arrived: 60 })
    expect(r.rates.embeddedPerMinute).toBe(5)
    expect(r.rates.arrivedPerMinute).toBe(1)
    expect(r.state).toBe('draining')
  })

  it('passes the window to the database as well as into the arithmetic', async () => {
    counts('0', '0', '0', '0')

    await getThroughput(15)

    // The two windowed queries are the 3rd and 4th; both must be parameterised
    // with the same window the rates are divided by.
    const windowed = vi.mocked(query).mock.calls.slice(2)
    expect(windowed).toHaveLength(2)
    for (const [, params] of windowed) expect(params).toEqual(['15'])
  })

  it('treats a missing row as zero rather than NaN', async () => {
    const mocked = vi.mocked(query)
    for (let i = 0; i < 4; i++) mocked.mockResolvedValueOnce({ rows: [] } as any)

    const r = await getThroughput(60)

    expect(r.queue.pending).toBe(0)
    expect(r.rates.embeddedPerMinute).toBe(0)
    expect(r.state).toBe('caught-up')
  })
})
