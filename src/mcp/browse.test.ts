import { describe, it, expect, vi, beforeEach } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../db/postgres.js', () => ({ query }))

const { listSessions, listProjects, getActivity } = await import('./browse.js')

beforeEach(() => {
  query.mockReset()
  query.mockResolvedValue({ rows: [] })
})

const sql = () => query.mock.calls[0][0] as string
const params = () => query.mock.calls[0][1] as unknown[]

describe('listSessions', () => {
  it('excludes automated sessions unless asked for them', async () => {
    await listSessions({ limit: 10, offset: 0 })
    expect(sql()).toContain('s.is_automated = false')

    query.mockClear()
    await listSessions({ limit: 10, offset: 0, includeAutomated: true })
    expect(sql()).not.toContain('s.is_automated = false')
  })

  it('never returns soft-deleted sessions', async () => {
    await listSessions({ limit: 10, offset: 0 })
    expect(sql()).toContain('s.deleted_at IS NULL')
  })

  // A title filter has to search both columns off ONE bound parameter; an
  // earlier version mis-numbered the second placeholder.
  it('matches the search term against title and project with one parameter', async () => {
    await listSessions({ limit: 10, offset: 0, q: 'tunnel' })
    const clause = sql().match(/\(s\.title ILIKE (\$\d+) OR p\.name ILIKE (\$\d+)\)/)
    expect(clause).not.toBeNull()
    expect(clause![1]).toBe(clause![2])
    expect(params()).toContain('%tunnel%')
  })

  it('binds limit and offset last so filters cannot shift them', async () => {
    await listSessions({ limit: 25, offset: 50, projectId: 3, source: 'claude_code' })
    const bound = params()
    expect(bound.slice(-2)).toEqual([25, 50])
  })

  it('reports the pre-paging total from the window count', async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: 1,
          title: 't',
          summary: null,
          project: 'p',
          project_id: 2,
          source: 'claude_code',
          machine: 'windows',
          message_count: 5,
          chunk_count: '3',
          is_automated: false,
          started_at: '2026-01-01T00:00:00Z',
          last_synced_at: null,
          total: '412',
        },
      ],
    })

    const result = await listSessions({ limit: 1, offset: 0 })
    expect(result.total).toBe(412)
    expect(result.items[0]).toMatchObject({ id: 1, chunkCount: 3, messageCount: 5 })
  })

  // started_at is the session's FIRST message, and a session key can span years.
  // Ordering the list on it buries a thread that was active minutes ago below
  // sessions that merely began more recently.
  it('orders by last activity rather than by when the session began', async () => {
    await listSessions({ limit: 10, offset: 0 })
    expect(sql()).toContain('ORDER BY COALESCE(s.ended_at, s.started_at) DESC NULLS LAST')
  })

  it('is empty, not zero-length-undefined, when nothing matches', async () => {
    const result = await listSessions({ limit: 10, offset: 0 })
    expect(result).toEqual({ total: 0, items: [] })
  })
})

describe('listProjects', () => {
  it('groups projects with no machine under the unknown bucket', async () => {
    await listProjects()
    expect(params()).toEqual(['unknown'])
    expect(sql()).toContain('COALESCE(p.machine, $1)')
  })

  it('counts only live sessions', async () => {
    await listProjects()
    expect(sql()).toContain('s.deleted_at IS NULL')
  })

  // The column is called last_activity_at and it sorts the project list; taking
  // it from started_at made it the date of the project's oldest conversation.
  it('takes last activity from the newest message, not the oldest', async () => {
    await listProjects()
    expect(sql()).toContain('MAX(COALESCE(s.ended_at, s.started_at)) AS last_activity_at')
  })
})

describe('getActivity', () => {
  it('generates the full day span so empty days are still rows', async () => {
    await getActivity(30)
    expect(sql()).toContain('generate_series')
    expect(params()).toEqual([30])
  })

  // A thread that began in 2014 and received a message tonight belongs in
  // tonight's bar, not in a bar eleven years off the left of the chart.
  it('buckets a session on its last activity', async () => {
    await getActivity(30)
    expect(sql()).toContain('ON COALESCE(s.ended_at, s.started_at) >= span.day')
  })

  it('coerces the counts postgres returns as strings', async () => {
    query.mockResolvedValue({ rows: [{ day: '2026-01-01', sessions: '4', messages: '900' }] })
    expect(await getActivity(1)).toEqual([{ day: '2026-01-01', sessions: 4, messages: 900 }])
  })
})

// Issue #95: /api/sessions is the UI's list surface. It already selected
// s.summary; it just returned the stale title column beside it.
describe('listSessions title resolution (#95)', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 1,
    title: null,
    summary: null,
    project: 'proj',
    project_id: 2,
    source: 'claude_code',
    machine: 'unknown',
    message_count: '10',
    is_automated: false,
    started_at: null,
    last_synced_at: null,
    chunk_count: '0',
    total: '1',
    ...over,
  })

  it('derives the title from the summary when none was stored', async () => {
    query.mockResolvedValue({ rows: [row({ summary: 'Wired up the ntfy alerts.\nMore detail.' })] })
    const { items } = await listSessions({ limit: 10, offset: 0 })
    expect(items[0].title).toBe('Wired up the ntfy alerts.')
    expect(items[0].titleSource).toBe('summary')
  })

  it('leaves the title null rather than guessing when there is no summary', async () => {
    query.mockResolvedValue({ rows: [row({})] })
    const { items } = await listSessions({ limit: 10, offset: 0 })
    expect(items[0].title).toBeNull()
    expect(items[0].titleSource).toBe('none')
  })
})

describe('listSessions withholds unsummarized sessions (#95)', () => {
  it('excludes them by default', async () => {
    await listSessions({ limit: 10, offset: 0 })
    expect(sql()).toContain('s.summary IS NOT NULL')
  })

  it('includes them when explicitly asked', async () => {
    await listSessions({ limit: 10, offset: 0, includeUnsummarized: true })
    expect(sql()).not.toContain('s.summary IS NOT NULL')
  })
})
