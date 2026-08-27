import { describe, it, expect, vi, beforeEach } from 'vitest'

const { query, insertMessage, updateSessionStats, getSessionByExternalId, ingestConversation } =
  vi.hoisted(() => ({
    query: vi.fn(),
    insertMessage: vi.fn(),
    updateSessionStats: vi.fn(),
    getSessionByExternalId: vi.fn(),
    ingestConversation: vi.fn(),
  }))

vi.mock('../db/postgres.js', () => ({
  query,
  queries: { insertMessage, updateSessionStats, getSessionByExternalId },
}))
vi.mock('../config.js', () => ({ config: { machine: 'test-box' } }))
// Replaying a spooled ingest reaches ingest.ts, which reaches chroma and ollama
// through search.ts. Quarantining stays testable with nothing but Postgres
// behind it — which is exactly why that import is lazy in the first place.
vi.mock('../mcp/ingest.js', () => ({ ingestConversation }))

const { quarantine, encodePayload, decodePayload, replayQuarantine, listQuarantine } = await import(
  './quarantine.js'
)

const NUL = String.fromCharCode(0)

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [{ id: 1 }] })
  insertMessage.mockReset().mockResolvedValue(1)
  updateSessionStats.mockReset().mockResolvedValue(undefined)
  getSessionByExternalId.mockReset().mockResolvedValue(null)
  ingestConversation.mockReset().mockResolvedValue({})
})

const input = (over = {}) => ({
  source: 'claude_code',
  filePath: '/p/session.jsonl',
  recordKey: 'line:12',
  stage: 'parse' as const,
  payload: '{"broken"',
  error: new Error('Unexpected end of JSON input'),
  ...over,
})

describe('payload encoding', () => {
  // The whole point of base64: the bytes that broke the original insert must not
  // be able to break the insert that preserves them.
  it('round-trips content that postgres would reject as text', () => {
    const poison = `wsl${NUL}--list${NUL}`
    expect(decodePayload(encodePayload(poison))).toBe(poison)
    expect(encodePayload(poison)).toMatch(/^[A-Za-z0-9+/=]*$/)
  })

  it('round-trips multibyte text', () => {
    const text = '汉字 · émoji 🧠 · "quotes"'
    expect(decodePayload(encodePayload(text))).toBe(text)
  })
})

describe('quarantine', () => {
  it('stores the payload base64-encoded, never as raw text', async () => {
    await quarantine(input({ payload: `bad${NUL}line` }))
    const params = query.mock.calls[0][1] as string[]
    expect(params).toContain(encodePayload(`bad${NUL}line`))
    expect(params.some(p => typeof p === 'string' && p.includes(NUL))).toBe(false)
  })

  it('records the reporting machine and the error message', async () => {
    await quarantine(input())
    const params = query.mock.calls[0][1] as unknown[]
    expect(params).toContain('test-box')
    expect(params).toContain('Unexpected end of JSON input')
  })

  // A second sync over the same file must not pile up duplicate rows.
  it('upserts on the record key and counts the attempt', async () => {
    await quarantine(input())
    const sql = query.mock.calls[0][0] as string
    expect(sql).toContain('ON CONFLICT (source, file_path, record_key) DO UPDATE')
    expect(sql).toContain('attempts = sync_quarantine.attempts + 1')
  })

  // The store of last resort must not be able to take sync down with it.
  it('returns null instead of throwing when even this write fails', async () => {
    query.mockRejectedValueOnce(new Error('disk full'))
    await expect(quarantine(input())).resolves.toBeNull()
  })

  // The error column is text, and the error string is derived from the
  // record's bytes: V8's JSON.parse quotes a snippet of the failing input in
  // e.message, raw NULs included. Unnormalized, the very bytes that broke the
  // original insert would break the INSERT that preserves them.
  it('normalizes NULs out of the error string before writing it', async () => {
    await quarantine(input({ error: new Error(`invalid W${NUL}S${NUL}L${NUL} bytes`) }))
    const params = query.mock.calls[0][1] as unknown[]
    expect(params).toContain('invalid WSL bytes')
    expect(params.some(p => typeof p === 'string' && p.includes(NUL))).toBe(false)
  })

  it('survives a genuine V8 parse error over NUL-bearing input', async () => {
    const parseError = (() => {
      try {
        JSON.parse(`{"a": W${NUL}S${NUL}L${NUL} garbage`)
        return null
      } catch (e) {
        return e
      }
    })()
    await quarantine(input({ error: parseError }))
    const params = query.mock.calls[0][1] as unknown[]
    expect(params.some(p => typeof p === 'string' && p.includes(NUL))).toBe(false)
  })
})

describe('replayQuarantine', () => {
  const row = (over = {}) => ({
    id: 5,
    source: 'claude_code',
    machine: 'test-box',
    file_path: '/p/session.jsonl',
    record_key: 'uuid:abc',
    line_number: 12,
    session_external_id: 'sess-1',
    session_id: 77,
    project_id: 3,
    stage: 'insert',
    error: 'boom',
    attempts: 1,
    first_seen_at: '2026-01-01T00:00:00Z',
    last_attempt_at: '2026-01-01T00:00:00Z',
    resolved_at: null,
    payload_base64: encodePayload(
      JSON.stringify({
        uuid: 'abc',
        parentUuid: null,
        role: 'user',
        contentText: 'hello',
        timestamp: '2026-01-01T00:00:00Z',
        sequenceNum: 4,
        isSidechain: false,
      })
    ),
    ...over,
  })

  it('re-inserts the stored record and marks it resolved', async () => {
    query.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValue({ rows: [] })

    const result = await replayQuarantine({ limit: 10 })

    expect(result).toMatchObject({ attempted: 1, recovered: 1 })
    expect(insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 77, externalId: 'abc', contentText: 'hello' })
    )
    // The timestamp must go back in as a Date, not the string it was stored as.
    expect(insertMessage.mock.calls[0][0].timestamp).toBeInstanceOf(Date)
    expect(query.mock.calls.some(c => String(c[0]).includes('SET resolved_at = NOW()'))).toBe(true)
  })

  it('re-parses a parse-stage record through the same parser sync uses', async () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      sessionId: 'sess-1',
      timestamp: '2026-01-01T00:00:00Z',
      message: { role: 'user', content: 'recovered text' },
    })
    query
      .mockResolvedValueOnce({ rows: [row({ stage: 'parse', payload_base64: encodePayload(line) })] })
      .mockResolvedValue({ rows: [] })

    const result = await replayQuarantine({ limit: 10 })

    expect(result.recovered).toBe(1)
    expect(insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: 'u1', contentText: 'recovered text' })
    )
  })

  it('keeps the row and bumps the attempt when the replay fails again', async () => {
    query.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValue({ rows: [] })
    insertMessage.mockRejectedValueOnce(new Error('still broken'))

    const result = await replayQuarantine({ limit: 10 })

    expect(result).toMatchObject({ attempted: 1, recovered: 0 })
    expect(result.outcomes[0].error).toContain('still broken')
    expect(query.mock.calls.some(c => String(c[0]).includes('attempts = attempts + 1'))).toBe(true)
  })

  it('resolves the session from the project when none was recorded', async () => {
    query.mockResolvedValueOnce({ rows: [row({ session_id: null })] }).mockResolvedValue({ rows: [] })
    getSessionByExternalId.mockResolvedValue({ id: 91 })

    await replayQuarantine({ limit: 10 })

    expect(getSessionByExternalId).toHaveBeenCalledWith(3, 'sess-1')
    expect(insertMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 91 }))
  })

  // The attempt bookkeeping writes the new error into a text column; a
  // NUL-bearing replay failure must not poison it.
  it('normalizes a NUL-bearing replay error before recording the attempt', async () => {
    query.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValue({ rows: [] })
    insertMessage.mockRejectedValueOnce(new Error(`bad byte W${NUL}S${NUL}L`))

    const result = await replayQuarantine({ limit: 10 })

    expect(result.outcomes[0].error).toBe('bad byte WSL')
    const attemptCall = query.mock.calls.find(c => String(c[0]).includes('attempts = attempts + 1'))
    expect(attemptCall).toBeDefined()
    expect((attemptCall![1] as unknown[]).some(p => typeof p === 'string' && p.includes(NUL))).toBe(false)
  })

  // One record whose bookkeeping fails must not abort the rest of the batch —
  // otherwise a single poisoned row 500s every retry of everything behind it.
  it('continues the batch when recording an attempt fails', async () => {
    query.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM sync_quarantine'))
        return { rows: [row({ id: 5 }), row({ id: 6, record_key: 'uuid:def' })] }
      if (String(sql).includes('attempts = attempts + 1')) throw new Error('db hiccup')
      return { rows: [] }
    })
    insertMessage.mockRejectedValue(new Error('still broken'))

    const result = await replayQuarantine({ limit: 10 })

    expect(result.attempted).toBe(2)
    expect(result.recovered).toBe(0)
    expect(result.outcomes.map(o => o.id)).toEqual([5, 6])
  })

  it('reports rather than throws when the session still does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [row({ session_id: null })] }).mockResolvedValue({ rows: [] })

    const result = await replayQuarantine({ limit: 10 })

    expect(result.recovered).toBe(0)
    expect(result.outcomes[0].error).toContain('re-sync the file first')
    expect(insertMessage).not.toHaveBeenCalled()
    // The row must show what is blocking it now, not the error it arrived with.
    expect(query.mock.calls.some(c => String(c[0]).includes('attempts = attempts + 1'))).toBe(true)
  })
})

describe('listQuarantine', () => {
  it('hides resolved records unless asked for them', async () => {
    query.mockResolvedValue({ rows: [] })
    await listQuarantine({ limit: 10, offset: 0 })
    expect(query.mock.calls[0][0]).toContain('WHERE resolved_at IS NULL')

    query.mockClear()
    await listQuarantine({ limit: 10, offset: 0, includeResolved: true })
    expect(query.mock.calls[0][0]).not.toContain('WHERE resolved_at IS NULL')
  })

  it('omits payloads from a listing by default and decodes them when asked', async () => {
    query.mockResolvedValue({ rows: [] })
    await listQuarantine({ limit: 10, offset: 0 })
    expect(query.mock.calls[0][0]).not.toContain('payload_base64')

    query.mockClear().mockResolvedValue({
      rows: [
        {
          id: 1,
          source: 'claude_code',
          machine: null,
          file_path: '/p',
          record_key: 'line:1',
          line_number: 1,
          session_external_id: null,
          session_id: null,
          project_id: null,
          stage: 'parse',
          error: 'e',
          attempts: 1,
          first_seen_at: 'x',
          last_attempt_at: 'x',
          resolved_at: null,
          payload_base64: encodePayload('raw line'),
          total: '1',
        },
      ],
    })
    const result = await listQuarantine({ limit: 10, offset: 0, withPayload: true })
    expect(result.items[0].payload).toBe('raw line')
    expect(result.total).toBe(1)
  })
})

// A spooled ingest is a whole conversation, not a Claude transcript line, so
// replay has to dispatch on the source — feeding an IngestPayload to
// parseClaudeLine would fail every retry forever and look like bad data.
describe('replaying a quarantined spool payload', () => {
  const payload = JSON.stringify({
    source: 'huddle',
    project: { externalId: 'C01', name: '#platform-team' },
    session: { externalId: 'huddle-1', title: 'Rollout sync', startedAt: '2026-07-30T14:30:00Z' },
    messages: [
      {
        externalId: 'huddle-1-0',
        role: 'user',
        content: 'before or after the migration?',
        timestamp: '2026-07-30T14:30:12Z',
        sequenceNum: 0,
      },
    ],
  })

  const spoolRow = (over = {}) => ({
    id: 9,
    source: 'ingest_spool',
    machine: 'test-box',
    file_path: 'https://gateway.example.com/ingest/mindmeld',
    record_key: 'a.json',
    line_number: null,
    session_external_id: null,
    session_id: null,
    project_id: null,
    stage: 'insert',
    error: 'dataClass is required',
    attempts: 1,
    first_seen_at: '2026-08-01T00:00:00Z',
    last_attempt_at: '2026-08-01T00:00:00Z',
    resolved_at: null,
    payload_base64: encodePayload(payload),
    ...over,
  })

  it('replays it through ingestConversation and marks it resolved', async () => {
    query.mockResolvedValueOnce({ rows: [spoolRow()] }).mockResolvedValue({ rows: [] })

    const result = await replayQuarantine({ limit: 10 })

    expect(result).toMatchObject({ attempted: 1, recovered: 1 })
    expect(ingestConversation).toHaveBeenCalledOnce()
    // The stored JSON goes back through the same schema the drain used, so the
    // timestamps arrive as Dates and not as the strings they were spooled as.
    const sent = ingestConversation.mock.calls[0][0]
    expect(sent.source).toBe('huddle')
    expect(sent.session.startedAt).toBeInstanceOf(Date)
    expect(sent.messages[0].timestamp).toBeInstanceOf(Date)
    // None of the Claude-transcript machinery applies to this row.
    expect(insertMessage).not.toHaveBeenCalled()
    expect(getSessionByExternalId).not.toHaveBeenCalled()
    expect(query.mock.calls.some(c => String(c[0]).includes('SET resolved_at = NOW()'))).toBe(true)
  })

  it('keeps the row and bumps the attempt when the ingest fails again', async () => {
    query.mockResolvedValueOnce({ rows: [spoolRow()] }).mockResolvedValue({ rows: [] })
    ingestConversation.mockRejectedValueOnce(new Error('dataClass is required'))

    const result = await replayQuarantine({ limit: 10 })

    expect(result).toMatchObject({ attempted: 1, recovered: 0 })
    expect(result.outcomes[0].error).toContain('dataClass is required')
    expect(query.mock.calls.some(c => String(c[0]).includes('attempts = attempts + 1'))).toBe(true)
  })

  // The payload was quarantined *because* it was rejected, so a schema-invalid
  // one has to report rather than throw out of the batch.
  it('reports a payload the schema still rejects instead of throwing', async () => {
    query
      .mockResolvedValueOnce({ rows: [spoolRow({ payload_base64: encodePayload('{"not":"a payload"}') })] })
      .mockResolvedValue({ rows: [] })

    const result = await replayQuarantine({ limit: 10 })

    expect(result).toMatchObject({ attempted: 1, recovered: 0 })
    expect(result.outcomes[0].error).toBeTruthy()
    expect(ingestConversation).not.toHaveBeenCalled()
  })
})
