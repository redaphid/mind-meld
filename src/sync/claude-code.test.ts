import { describe, it, expect, vi, beforeEach } from 'vitest'

const { upsertSession, insertMessage, updateSessionStats, updateSessionContentChars, quarantineMock } =
  vi.hoisted(() => ({
    upsertSession: vi.fn(),
    insertMessage: vi.fn(),
    updateSessionStats: vi.fn(),
    updateSessionContentChars: vi.fn(),
    quarantineMock: vi.fn(),
  }))

vi.mock('../db/postgres.js', () => ({
  queries: { upsertSession, insertMessage, updateSessionStats, updateSessionContentChars },
}))
vi.mock('./quarantine.js', () => ({ quarantine: quarantineMock }))
vi.mock('../config.js', () => ({ config: { machine: 'test-box', sources: { claudeCode: { path: '/nope' } } } }))

const { syncSession } = await import('./claude-code.js')

beforeEach(() => {
  upsertSession.mockReset().mockResolvedValue(77)
  insertMessage.mockReset().mockResolvedValue(1)
  updateSessionStats.mockReset().mockResolvedValue(undefined)
  updateSessionContentChars.mockReset().mockResolvedValue(undefined)
  quarantineMock.mockReset().mockResolvedValue(1)
})

const msg = (uuid: string, sequenceNum: number) => ({
  uuid,
  parentUuid: null,
  role: 'user' as const,
  contentText: `content of ${uuid}`,
  timestamp: new Date('2026-01-01T00:00:00Z'),
  sequenceNum,
  isSidechain: false,
})

const session = (over: Record<string, unknown> = {}) => ({
  sessionId: 'sess-1',
  filePath: '/p/sess-1.jsonl',
  fileModifiedAt: new Date('2026-01-01T00:00:00Z'),
  isAgent: false,
  messages: [msg('u1', 0), msg('u2', 1)],
  firstTimestamp: new Date('2026-01-01T00:00:00Z'),
  lastTimestamp: new Date('2026-01-01T00:01:00Z'),
  totalInputTokens: 0,
  totalOutputTokens: 0,
  badLines: [],
  lineNumbers: new Map([
    ['u1', 1],
    ['u2', 2],
  ]),
  ...over,
})

describe('syncSession', () => {
  it('inserts every message on the happy path, nothing quarantined', async () => {
    const result = await syncSession(1, 3, session() as never)
    expect(result).toEqual({ messagesInserted: 2, quarantined: 0, errors: [] })
    expect(quarantineMock).not.toHaveBeenCalled()
    expect(updateSessionStats).toHaveBeenCalledWith(77)
  })

  // The one insert per-message quarantine cannot protect. Before this guard,
  // a failing session upsert threw the whole file with nothing preserved —
  // which is exactly how issue #20's live failure bypassed the quarantine.
  it('quarantines every record when the session upsert itself fails', async () => {
    upsertSession.mockRejectedValueOnce(new Error('invalid byte sequence for encoding "UTF8": 0x00'))

    const result = await syncSession(1, 3, session() as never)

    expect(result).toEqual({ messagesInserted: 0, quarantined: 2, errors: [] })
    expect(quarantineMock).toHaveBeenCalledTimes(2)
    // No session row exists, so records carry the external id + project and
    // resolve on replay.
    expect(quarantineMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionExternalId: 'sess-1',
        projectId: 3,
        recordKey: 'uuid:u1',
        stage: 'insert',
      })
    )
    expect(quarantineMock.mock.calls.every(c => c[0].sessionId === undefined)).toBe(true)
    expect(insertMessage).not.toHaveBeenCalled()
    expect(updateSessionStats).not.toHaveBeenCalled()
  })

  it('quarantines a failing message and keeps the rest of the conversation', async () => {
    insertMessage.mockRejectedValueOnce(new Error('boom'))

    const result = await syncSession(1, 3, session() as never)

    expect(result).toEqual({ messagesInserted: 1, quarantined: 1, errors: [] })
    expect(quarantineMock).toHaveBeenCalledWith(
      expect.objectContaining({ recordKey: 'uuid:u1', sessionId: 77, stage: 'insert' })
    )
  })

  // quarantine() returning null means the preserving write itself failed.
  // That is a loss, and it must surface as an error — never be counted as
  // saved, never let /status claim "data is waiting" for data that is gone.
  it('reports an error instead of counting a failed quarantine write as saved', async () => {
    insertMessage.mockRejectedValueOnce(new Error('boom'))
    quarantineMock.mockResolvedValueOnce(null)

    const result = await syncSession(1, 3, session() as never)

    expect(result.quarantined).toBe(0)
    expect(result.messagesInserted).toBe(1)
    expect(result.errors).toEqual([
      'Quarantine write failed for /p/sess-1.jsonl#uuid:u1 — record NOT preserved',
    ])
  })

  it('reports every loss when quarantine fails during a session-upsert failure', async () => {
    upsertSession.mockRejectedValueOnce(new Error('nope'))
    quarantineMock.mockResolvedValue(null)

    const result = await syncSession(1, 3, session() as never)

    expect(result.quarantined).toBe(0)
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toContain('NOT preserved')
  })

  it('quarantines unreadable lines against the session row', async () => {
    const result = await syncSession(
      1,
      3,
      session({ badLines: [{ lineNumber: 9, raw: '{"broken', error: 'Unexpected end' }] }) as never
    )

    expect(result.quarantined).toBe(1)
    expect(quarantineMock).toHaveBeenCalledWith(
      expect.objectContaining({ recordKey: 'line:9', sessionId: 77, stage: 'parse', payload: '{"broken' })
    )
  })
})
