import { describe, it, expect, vi } from 'vitest'

const query = vi.fn(async (..._args: unknown[]) => ({ rows: [], rowCount: 2 }))
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const {
  createSearchLog,
  searchLog,
  expireRawRequests,
  mintListHandle,
  parseListHandle,
  mcpCaller,
  restCaller,
  toLoggedHits,
  requestHash,
} = await import('./search-log.js')
type LogEvent = import('./search-log.js').LogEvent

const event = (n: number): LogEvent => ({
  kind: 'follow-up',
  at: new Date(),
  caller: { key: 'mcp:a', transport: 'mcp-http', client: 'test/1' },
  tool: 'getSession',
  request: { sessionId: n },
  target: { sessionId: n },
  list: null,
})

const never = () => new Promise<void>(() => {})

describe('createSearchLog', () => {
  it('returns before the row is written', () => {
    const insert = vi.fn(never)
    const log = createSearchLog({ insert, capacity: 10, enabled: true })
    log.record(event(1))
    expect(log.stats()).toMatchObject({ written: 0, queued: 1 })
  })

  it('writes rows in the order they were recorded', async () => {
    const seen: unknown[] = []
    const log = createSearchLog({ insert: async (e) => void seen.push(e.request.sessionId), capacity: 10, enabled: true })
    for (const n of [1, 2, 3]) log.record(event(n))
    await log.flushed()
    expect(seen).toEqual([1, 2, 3])
    expect(log.stats()).toMatchObject({ written: 3, failed: 0, queued: 0 })
  })

  it('counts a failed write, keeps going, and exposes only the SQLSTATE', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const insert = vi
      .fn<(e: LogEvent) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('Failing row contains (secret query)'), { code: '23502' }))
      .mockResolvedValue(undefined)
    const log = createSearchLog({ insert, capacity: 10, enabled: true })
    expect(() => {
      log.record(event(1))
      log.record(event(2))
    }).not.toThrow()
    await log.flushed()
    const stats = log.stats()
    expect(stats).toMatchObject({ written: 1, failed: 1, lastFailureCode: '23502' })
    expect(JSON.stringify(stats)).not.toContain('secret')
    expect(spy.mock.calls.flat().join(' ')).not.toContain('secret')
    spy.mockRestore()
  })

  it('drops and counts rows past capacity instead of growing', () => {
    const log = createSearchLog({ insert: never, capacity: 3, enabled: true })
    for (let n = 0; n < 10; n++) log.record(event(n))
    const { queued, dropped } = log.stats()
    expect(queued).toBeLessThanOrEqual(3)
    expect(dropped).toBe(10 - 3)
  })

  it('records nothing when switched off', async () => {
    const insert = vi.fn(async () => {})
    const log = createSearchLog({ insert, capacity: 3, enabled: false })
    log.record(event(1))
    await log.flushed()
    expect(insert).not.toHaveBeenCalled()
    expect(log.stats().enabled).toBe(false)
  })
})

describe('list handles', () => {
  it('mints handles that parse back, and rejects anything else', () => {
    const handles = new Set(Array.from({ length: 200 }, mintListHandle))
    expect(handles.size).toBe(200)
    for (const h of handles) expect(parseListHandle(h)).toBe(h)
    for (const bad of ['L12345', 'Labcdefg', 'lk3x9qa', "L'; --", 42, undefined]) expect(parseListHandle(bad)).toBeNull()
  })
})

describe('caller keys', () => {
  it('keys HTTP MCP by transport session and stdio by process', () => {
    expect(mcpCaller('mcp-http', 'abc-123', { name: 'claude-code', version: '2.1' })).toEqual({
      key: 'mcp:abc-123',
      transport: 'mcp-http',
      client: 'claude-code/2.1',
    })
    const stdio = mcpCaller('mcp-stdio', undefined, undefined)
    expect(stdio.key).toMatch(new RegExp(`^stdio:${process.pid}\\.`))
    expect(stdio.client).toBe('unknown')
  })

  it('takes a REST caller from its headers, and refuses a malformed one', () => {
    const headers = (h: Record<string, string>) => (name: string) => h[name]
    expect(restCaller(headers({ 'x-mindmeld-caller': 'ui:t9', 'x-mindmeld-client': 'web-ui' }))).toEqual({
      key: 'rest:ui:t9',
      transport: 'rest',
      client: 'web-ui',
    })
    expect(restCaller(headers({ 'x-mindmeld-caller': 'a b<script>' })).key).toBe('rest:anon')
    expect(restCaller(headers({})).client).toBe('rest')
  })
})

describe('logged results', () => {
  it('ranks from 1 and keeps tier, damping and cursor', () => {
    const base = { project_name: 'p', project_path: '/p', source: 's', data_class: 'coding', title: null, title_source: 'none' as const, date: new Date(), snippet: null }
    expect(
      toLoggedHits([
        { ...base, session_id: 9, score: 0.03, matched_tier: 'message', noise_damping: 0.9, cursor: { message_id: 5 } },
        { ...base, session_id: 4, score: 0.02, matched_tier: 'session' },
      ])
    ).toEqual([
      { s: 9, rank: 1, score: 0.03, tier: 'message', damping: 0.9, cursor: { message_id: 5 } },
      { s: 4, rank: 2, score: 0.02, tier: 'session', damping: null },
    ])
  })

  it('hashes a request the same whatever its key order', () => {
    expect(requestHash({ query: 'a', limit: 3 })).toBe(requestHash({ limit: 3, query: 'a', mode: undefined }))
    expect(requestHash({ query: 'a' })).not.toBe(requestHash({ query: 'b' }))
  })
})

// src/mcp/search-log.pg.test.ts runs these statements for real; here, where
// there is no database, the parameters must still land in the right columns.
describe('the rows the default log writes', () => {
  const caller = { key: 'mcp:abc', transport: 'mcp-http' as const, client: 'c/1' }
  const at = new Date('2026-11-13T00:00:00Z')

  it('writes a search with its handle, mode, ranked results and timing', async () => {
    query.mockClear()
    searchLog.record({
      kind: 'search', at, caller, tool: 'search', list: 'Lk3x9qa' as never, request: { query: 'q' }, mode: 'text', totalMs: 12,
      results: [], degraded: { semantic: false, cause: 'unavailable', reason: 'gate shut' },
    })
    await searchLog.flushed()
    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO search_log')
    expect(params).toEqual([at, 'mcp:abc', 'mcp-http', 'c/1', 'search', 'Lk3x9qa', { query: 'q' }, requestHash({ query: 'q' }), 'text', '[]', 0, 'unavailable', null, { totalMs: 12 }])
  })

  it('writes a failed search with its error class and no results', async () => {
    query.mockClear()
    searchLog.record({ kind: 'search', at, caller, tool: 'rest:search', list: 'Lk3x9qa' as never, request: {}, mode: 'hybrid', totalMs: 1, error: 'TypeError' })
    await searchLog.flushed()
    const params = query.mock.calls[0][1] as unknown[]
    expect(params.slice(9, 13)).toEqual([null, null, null, 'TypeError'])
  })

  it('writes a follow-up with its kind, signal and target ids', async () => {
    query.mockClear()
    searchLog.record({ kind: 'follow-up', at, caller, tool: 'reportUselessSession', request: { sessionId: 4 }, target: { sessionId: 4 }, list: null })
    searchLog.record({ kind: 'follow-up', at, caller, tool: 'getMessage', request: { id: 9 }, target: { messageId: 9 }, list: 'Lk3x9qa' as never })
    await searchLog.flushed()
    const [report, open] = query.mock.calls.map((c) => c[1] as unknown[])
    expect([report[4], report[5], report[6], report[10], report[11], report[12]]).toEqual(['tag', 'reportUselessSession', null, 4, null, 'useless'])
    expect([open[4], open[6], open[10], open[11], open[12]]).toEqual(['open', 'Lk3x9qa', null, 9, 'open'])
  })

  it('expires query text older than the retention window', async () => {
    query.mockClear()
    expect(await expireRawRequests(30)).toBe(2)
    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/SET request = NULL/)
    expect(params).toEqual([30])
  })
})
