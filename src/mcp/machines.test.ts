import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const { getMachineActivity, getMachineSessions, mostRecentlyIndexed, UNKNOWN_MACHINE } =
  await import('./machines.js')

type Row = Record<string, unknown>
const rows = (...r: Row[]) => ({ rows: r })

const activityRow = (over: Row = {}): Row => ({
  machine: 'windows',
  projects: '3',
  sessions: '10',
  messages: '250',
  last_indexed_at: '2026-08-01T23:47:10.000Z',
  last_session_id: 42,
  last_session_title: 'a session',
  last_session_project: 'mind-meld',
  last_session_synced_at: '2026-08-01T23:47:10.000Z',
  ...over,
})

beforeEach(() => {
  query.mockReset()
})

describe('getMachineActivity', () => {
  it('coerces Postgres count strings into numbers', async () => {
    query.mockResolvedValue(rows(activityRow()))
    const [m] = await getMachineActivity()

    expect(m.projects).toBe(3)
    expect(m.sessions).toBe(10)
    expect(m.messages).toBe(250)
    expect(m.machine).toBe('windows')
  })

  it('passes the unknown-machine label to the query so NULLs group under it', async () => {
    query.mockResolvedValue(rows())
    await getMachineActivity()

    expect(query.mock.calls[0][1]).toEqual([UNKNOWN_MACHINE])
  })

  it('nests the latest session when there is one', async () => {
    query.mockResolvedValue(rows(activityRow()))
    const [m] = await getMachineActivity()

    expect(m.lastSession).toEqual({
      id: 42,
      title: 'a session',
      project: 'mind-meld',
      syncedAt: '2026-08-01T23:47:10.000Z',
    })
  })

  it('reports lastSession as null for a machine with no sessions', async () => {
    query.mockResolvedValue(rows(activityRow({ last_session_id: null, sessions: '0' })))
    const [m] = await getMachineActivity()

    expect(m.lastSession).toBeNull()
    expect(m.sessions).toBe(0)
  })

  it('returns full session titles rather than clipping them', async () => {
    const title = 'T'.repeat(5000)
    query.mockResolvedValue(rows(activityRow({ last_session_title: title })))
    const [m] = await getMachineActivity()

    expect(m.lastSession?.title).toHaveLength(5000)
  })
})

describe('mostRecentlyIndexed', () => {
  it('names the first machine that has ever been indexed', async () => {
    query.mockResolvedValue(
      rows(
        activityRow({ machine: 'wsl-box', last_indexed_at: '2026-08-02T00:14:40.000Z' }),
        activityRow({ machine: 'windows', last_indexed_at: '2026-08-01T23:47:10.000Z' })
      )
    )
    expect(mostRecentlyIndexed(await getMachineActivity())).toBe('wsl-box')
  })

  it('skips machines that have never been indexed', async () => {
    query.mockResolvedValue(
      rows(
        activityRow({ machine: 'gpu-host', last_indexed_at: null }),
        activityRow({ machine: 'windows', last_indexed_at: '2026-08-01T23:47:10.000Z' })
      )
    )
    expect(mostRecentlyIndexed(await getMachineActivity())).toBe('windows')
  })

  it('returns null when nothing has been indexed at all', () => {
    expect(mostRecentlyIndexed([])).toBeNull()
  })
})

describe('getMachineSessions', () => {
  it('filters by machine and applies limit/offset', async () => {
    query.mockResolvedValue(rows())
    await getMachineSessions('wsl-box', 25, 50)

    expect(query.mock.calls[0][1]).toEqual([UNKNOWN_MACHINE, 'wsl-box', 25, 50])
  })

  it('maps rows and defaults a null message_count to zero', async () => {
    query.mockResolvedValue(
      rows({
        id: 7,
        title: 'hello',
        project: 'mind-meld',
        message_count: null,
        started_at: '2026-08-01T00:00:00.000Z',
        last_synced_at: '2026-08-01T01:00:00.000Z',
      })
    )
    const [s] = await getMachineSessions('windows', 10, 0)

    expect(s.id).toBe(7)
    expect(s.messageCount).toBe(0)
    expect(s.title).toBe('hello')
  })

  it('can be asked for the unknown bucket by name', async () => {
    query.mockResolvedValue(rows())
    await getMachineSessions(UNKNOWN_MACHINE, 10, 0)

    expect(query.mock.calls[0][1]).toEqual([UNKNOWN_MACHINE, UNKNOWN_MACHINE, 10, 0])
  })
})

// Issue #95: the per-machine session list showed the same stale title column.
describe('getMachineSessions title resolution (#95)', () => {
  it('derives the title from the summary when the source supplied none', async () => {
    query.mockResolvedValue(
      rows({
        id: 7,
        title: null,
        summary: 'Set up container monitoring.\nMore detail.',
        project: 'mind-meld',
        message_count: '3',
        started_at: null,
        last_synced_at: null,
      })
    )
    const [s] = await getMachineSessions('windows', 10, 0)
    expect(s.title).toBe('Set up container monitoring.')
    expect(s.titleSource).toBe('summary')
  })

  it('leaves the title null rather than guessing when there is no summary', async () => {
    query.mockResolvedValue(
      rows({
        id: 7,
        title: null,
        summary: null,
        project: 'mind-meld',
        message_count: '3',
        started_at: null,
        last_synced_at: null,
      })
    )
    const [s] = await getMachineSessions('windows', 10, 0)
    expect(s.title).toBeNull()
    expect(s.titleSource).toBe('none')
  })
})
