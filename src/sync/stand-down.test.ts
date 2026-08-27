import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../db/postgres.js', () => ({ query: vi.fn() }))

import { query } from '../db/postgres.js'
import {
  summarizeStandDown,
  clampMinutes,
  shouldStandDown,
  invalidateStandDownCache,
  readStandDown,
  standDown,
  resumeSync,
  DEFAULT_STAND_DOWN_MINUTES,
  MAX_STAND_DOWN_MINUTES,
} from './stand-down.js'

const NOW = new Date('2026-08-02T12:00:00.000Z')
const rows = (row: unknown) => ({ rows: row ? [row] : [] }) as never

beforeEach(() => {
  vi.mocked(query).mockReset()
  invalidateStandDownCache()
})

// The switch is a deadline, not a flag, and every property worth having comes
// from that: it stops the pass in flight, and it cannot outlive the gap to the
// next cycle no matter who forgets what.
describe('summarizeStandDown', () => {
  it('is standing down while the deadline is ahead', () => {
    const state = summarizeStandDown(
      {
        stand_down_until: new Date('2026-08-02T12:10:00.000Z'),
        stand_down_at: new Date('2026-08-02T11:55:00.000Z'),
        stand_down_reason: 'stood down from the dashboard',
      },
      NOW
    )
    expect(state.standingDown).toBe(true)
    expect(state.secondsRemaining).toBe(600)
    expect(state.until).toBe('2026-08-02T12:10:00.000Z')
    expect(state.reason).toBe('stood down from the dashboard')
  })

  // The self-healing property. A worker killed mid-pass, or a person who
  // pressed the button and went to bed, must not leave the index frozen — the
  // deadline lapses on its own and the next cycle runs.
  it('is not standing down once the deadline has passed', () => {
    const state = summarizeStandDown(
      {
        stand_down_until: new Date('2026-08-02T11:59:59.000Z'),
        stand_down_at: new Date('2026-08-02T11:45:00.000Z'),
        stand_down_reason: 'forgotten',
      },
      NOW
    )
    expect(state.standingDown).toBe(false)
    expect(state.secondsRemaining).toBe(0)
  })

  it('treats a never-pressed switch, and a missing row, as running', () => {
    expect(
      summarizeStandDown(
        { stand_down_until: null, stand_down_at: null, stand_down_reason: null },
        NOW
      ).standingDown
    ).toBe(false)
    expect(summarizeStandDown(undefined, NOW).standingDown).toBe(false)
  })
})

describe('clampMinutes', () => {
  it('defaults when given nothing usable', () => {
    expect(clampMinutes(undefined)).toBe(DEFAULT_STAND_DOWN_MINUTES)
    expect(clampMinutes('soon')).toBe(DEFAULT_STAND_DOWN_MINUTES)
  })

  // The ceiling is what keeps a "stop for a bit" button from becoming an
  // invisible off switch for the whole index.
  it('holds the window between one minute and the ceiling', () => {
    expect(clampMinutes(0)).toBe(1)
    expect(clampMinutes(-30)).toBe(1)
    expect(clampMinutes(60)).toBe(60)
    expect(clampMinutes(10_000)).toBe(MAX_STAND_DOWN_MINUTES)
  })
})

describe('shouldStandDown', () => {
  it('reports the stored deadline', async () => {
    vi.mocked(query).mockResolvedValue(
      rows({
        stand_down_until: new Date(Date.now() + 60_000),
        stand_down_at: new Date(),
        stand_down_reason: null,
      })
    )
    expect(await shouldStandDown()).toBe(true)
  })

  // Workers ask this between every batch and every session. Without the cache
  // that is a query per summarized session, forever, for a row that changes
  // when somebody presses a button.
  it('caches so a checkpoint is not a query', async () => {
    vi.mocked(query).mockResolvedValue(
      rows({ stand_down_until: null, stand_down_at: null, stand_down_reason: null })
    )
    await shouldStandDown()
    await shouldStandDown()
    await shouldStandDown()
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1)
  })

  // Fails OPEN, and this is the important one. The table arrives in a migration
  // applied by the `mcp` service, so a sync worker can legitimately meet a
  // database without it. Refusing to index because the pause button is
  // unreadable would be a far worse failure than ignoring a press.
  it('keeps working when the switch cannot be read', async () => {
    vi.mocked(query).mockRejectedValue(new Error('relation "sync_control" does not exist'))
    expect(await shouldStandDown()).toBe(false)
  })

  it('does not retry a failing read on every checkpoint', async () => {
    vi.mocked(query).mockRejectedValue(new Error('nope'))
    await shouldStandDown()
    await shouldStandDown()
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1)
  })
})

describe('pressing the button', () => {
  // The deadline is computed by Postgres, not by whichever container happened
  // to serve the request: the workers, the UI and the database keep three
  // clocks that are only approximately friends, and every reader compares
  // against the same one.
  it('sets the deadline from the database clock', async () => {
    vi.mocked(query).mockResolvedValue(
      rows({
        stand_down_until: new Date(Date.now() + 900_000),
        stand_down_at: new Date(),
        stand_down_reason: 'gaming',
      })
    )
    const state = await standDown(15, 'gaming')
    expect(state.standingDown).toBe(true)

    const [sql, params] = vi.mocked(query).mock.calls[0]
    expect(sql).toContain('now() +')
    expect(params).toEqual(['15', 'gaming'])
  })

  it('clamps an absurd window before it reaches the database', async () => {
    vi.mocked(query).mockResolvedValue(rows({ stand_down_until: null, stand_down_at: null, stand_down_reason: null }))
    await standDown(10_000)
    expect(vi.mocked(query).mock.calls[0][1]).toEqual([String(MAX_STAND_DOWN_MINUTES), null])
  })

  // "I finished playing, get back to work" should not cost the rest of the
  // window.
  it('resume clears the deadline outright', async () => {
    vi.mocked(query).mockResolvedValue(rows(null))
    expect((await resumeSync()).standingDown).toBe(false)
    expect(vi.mocked(query).mock.calls[0][0]).toContain('stand_down_until = NULL')
  })

  // Both writes have to drop the cache, or the worker that just got told to
  // stop keeps working for another beat — and, worse, a resume takes effect
  // late enough to look broken.
  it('invalidates the cache so the next checkpoint sees the change', async () => {
    vi.mocked(query).mockResolvedValue(
      rows({ stand_down_until: new Date(Date.now() + 60_000), stand_down_at: new Date(), stand_down_reason: null })
    )
    await shouldStandDown()
    expect(await shouldStandDown()).toBe(true)

    vi.mocked(query).mockResolvedValue(rows(null))
    await resumeSync()
    expect(await shouldStandDown()).toBe(false)
  })
})

describe('readStandDown', () => {
  it('reads the one control row', async () => {
    vi.mocked(query).mockResolvedValue(rows(null))
    expect(await readStandDown()).toMatchObject({ standingDown: false })
    expect(vi.mocked(query).mock.calls[0][0]).toContain('WHERE id = TRUE')
  })
})
