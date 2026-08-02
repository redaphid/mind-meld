import { describe, it, expect, vi, beforeEach } from 'vitest'

const { poolQuery, clientQuery, clientRelease } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
}))

vi.mock('pg', () => ({
  default: {
    Pool: class {
      query = poolQuery
      on() {}
      connect = async () => ({ query: clientQuery, release: clientRelease })
      end = async () => {}
    },
  },
}))

const { queries, transaction, closePool } = await import('./postgres.js')

beforeEach(() => {
  poolQuery.mockReset()
  clientQuery.mockReset()
  clientRelease.mockReset()
  poolQuery.mockResolvedValue({
    rows: [{ id: 1, name: 'huddle', data_class: 'meetings' }],
    rowCount: 1,
  })
  clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
})

const lastCall = () => poolQuery.mock.calls[poolQuery.mock.calls.length - 1]

describe('getOrCreateSource', () => {
  it('stamps a new source with the given class, defaulting to personal', async () => {
    await queries.getOrCreateSource('huddle', 'Slack Huddles', 'meetings')
    const [sql, params] = poolQuery.mock.calls[0]
    expect(sql).toContain(`COALESCE($3, 'personal')`)
    expect(params).toEqual(['huddle', 'Slack Huddles', 'meetings'])
  })

  it('passes null when no class is given, so the SQL default (personal) applies', async () => {
    await queries.getOrCreateSource('huddle')
    const [, params] = poolQuery.mock.calls[0]
    expect(params).toEqual(['huddle', 'huddle', null])
  })

  // /api/ingest is unauthenticated; if the upsert updated data_class on
  // conflict, one POST could reclassify android → coding and expose every
  // personal session to the default search.
  it('never updates data_class on conflict — ingest cannot reclassify an existing source', async () => {
    await queries.getOrCreateSource('android', undefined, 'coding')
    const [sql] = poolQuery.mock.calls[0]
    const updateClause = sql.slice(sql.indexOf('DO UPDATE SET'), sql.indexOf('RETURNING'))
    expect(updateClause).not.toContain('data_class')
  })
})

describe('source and project lookups', () => {
  it('getSourceByName returns the row or null', async () => {
    expect(await queries.getSourceByName('huddle')).toMatchObject({ name: 'huddle' })
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await queries.getSourceByName('nope')).toBeNull()
  })

  it('upsertProject strips NULs from text params and defaults machine to this host', async () => {
    await queries.upsertProject(1, 'ext\u0000id', '/p/x', 'proj')
    const [, params] = lastCall()
    expect(params[1]).toBe('extid')
    expect(typeof params[4]).toBe('string') // config.machine, not null
  })

  it('upsertProject passes null machine through so a known origin is preserved', async () => {
    await queries.upsertProject(1, 'ext', '/p/x', 'proj', null)
    const [sql, params] = lastCall()
    expect(params[4]).toBeNull()
    expect(sql).toContain('COALESCE($5, projects.machine)')
  })

  it('getProjectByExternalId returns null when absent', async () => {
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await queries.getProjectByExternalId(1, 'x')).toBeNull()
  })
})

describe('session upserts and lookups', () => {
  it('upsertSession classifies automated sessions from the title', async () => {
    poolQuery.mockResolvedValue({ rows: [{ id: 9 }], rowCount: 1 })
    await queries.upsertSession({
      projectId: 1,
      externalId: 's1',
      title: 'You are a Slack monitoring assistant',
    })
    expect(lastCall()[1][14]).toBe(true)

    await queries.upsertSession({ projectId: 1, externalId: 's2', title: 'Fixing the build' })
    expect(lastCall()[1][14]).toBe(false)
  })

  // Every subagent transcript already has a session row by the time linkage
  // ships (#48), so the linkage only ever arrives on the conflict path. An
  // INSERT-only parent_session_id would compute the parent, pass it, and
  // silently throw it away on every re-sync.
  it('upsertSession writes parent_session_id on the conflict path too', async () => {
    poolQuery.mockResolvedValue({ rows: [{ id: 9 }], rowCount: 1 })
    await queries.upsertSession({
      projectId: 1,
      externalId: 'agent-abc',
      isAgent: true,
      parentSessionId: 42,
    })
    const [sql, params] = lastCall()
    expect(params[4]).toBe(42)
    // COALESCE, not a bare assignment: a run that cannot resolve the parent
    // yet must never clear a link an earlier run established.
    expect(sql).toContain('parent_session_id = COALESCE($5, sessions.parent_session_id)')
  })

  it('getSessionByExternalId / global variant return null when absent', async () => {
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await queries.getSessionByExternalId(1, 'x')).toBeNull()
    expect(await queries.getSessionByExternalIdGlobal(1, 'x')).toBeNull()
  })

  it('getLatestFileModified unwraps the max or null', async () => {
    const when = new Date('2026-01-01T00:00:00Z')
    poolQuery.mockResolvedValue({ rows: [{ max_modified: when }], rowCount: 1 })
    expect(await queries.getLatestFileModified(1)).toEqual(when)
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await queries.getLatestFileModified(1)).toBeNull()
  })

  it('content-chars helpers read and write the running total', async () => {
    await queries.updateSessionContentChars(5)
    expect(lastCall()[1]).toEqual([5])
    poolQuery.mockResolvedValue({ rows: [{ content_chars: 42 }], rowCount: 1 })
    expect(await queries.getSessionContentChars(5)).toBe(42)
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await queries.getSessionContentChars(5)).toBe(0)
  })

  it('updateSessionStats delegates to the SQL function', async () => {
    await queries.updateSessionStats(5)
    expect(lastCall()[0]).toContain('update_session_stats($1::integer)')
  })
})

describe('insertMessage', () => {
  it('serialises JSON params with NUL repair and returns the new id', async () => {
    poolQuery.mockResolvedValue({ rows: [{ id: 77 }], rowCount: 1 })
    const id = await queries.insertMessage({
      sessionId: 1,
      externalId: 'm1',
      role: 'user',
      contentText: 'hi\u0000there',
      contentJson: { note: 'a\u0000b' },
      timestamp: new Date('2026-01-01T00:00:00Z'),
    })
    expect(id).toBe(77)
    const [, params] = lastCall()
    expect(params[4]).toBe('hithere')
    expect(JSON.parse(params[5] as string)).toEqual({ note: 'ab' })
  })

  it('returns null on conflict (DO NOTHING yields no row)', async () => {
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    const id = await queries.insertMessage({
      sessionId: 1,
      externalId: 'm1',
      role: 'user',
      timestamp: new Date('2026-01-01T00:00:00Z'),
    })
    expect(id).toBeNull()
  })
})

describe('sync state and search helpers', () => {
  it('getSyncState returns null when the source has never synced', async () => {
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await queries.getSyncState(1, 'sessions')).toBeNull()
  })

  it('updateSyncState cleans the error text', async () => {
    await queries.updateSyncState(1, 'sessions', 2, 10, 'boom\u0000!')
    expect(lastCall()[1][4]).toBe('boom!')
  })

  it('searchMessages passes the source filter through, defaulting to null', async () => {
    await queries.searchMessages('deploy', 5)
    expect(lastCall()[1]).toEqual(['deploy', 5, null])
    await queries.searchMessages('deploy', 5, 'claude_code')
    expect(lastCall()[1]).toEqual(['deploy', 5, 'claude_code'])
  })
})

describe('transaction', () => {
  it('commits and releases on success', async () => {
    const out = await transaction(async () => 'done')
    expect(out).toBe('done')
    const issued = clientQuery.mock.calls.map(([sql]) => sql)
    expect(issued).toContain('BEGIN')
    expect(issued).toContain('COMMIT')
    expect(clientRelease).toHaveBeenCalled()
  })

  it('rolls back and rethrows on failure', async () => {
    await expect(
      transaction(async () => {
        throw new Error('nope')
      })
    ).rejects.toThrow('nope')
    const issued = clientQuery.mock.calls.map(([sql]) => sql)
    expect(issued).toContain('ROLLBACK')
    expect(clientRelease).toHaveBeenCalled()
  })

  it('closePool tears the pool down', async () => {
    await expect(closePool()).resolves.toBeUndefined()
  })
})
