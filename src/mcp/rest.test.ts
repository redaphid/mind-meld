import { describe, it, expect } from 'vitest'
import { toSearchHit, toDigest, toMessages, toMessage } from './rest.js'
import type { SearchResult } from './search.js'
import type { SessionDigest, MessagesResult, SessionMessage } from './session.js'

const hit = (over: Partial<SearchResult> = {}): SearchResult => ({
  session_id: 42,
  project_name: 'mind-meld',
  project_path: '/p/mind-meld',
  source: 'claude_code',
  title: 'Debugging the backfill',
  date: new Date('2026-01-01T00:00:00Z'),
  score: 0.5,
  matched_tier: 'session',
  snippet: 'we fixed **NaN** embeddings',
  ...over,
})

const message = (over: Partial<SessionMessage> = {}): SessionMessage => ({
  id: 7,
  sequence_num: 3,
  role: 'user',
  content_text: 'hello',
  tool_name: null,
  timestamp: new Date('2026-01-01T00:00:00Z'),
  model: null,
  ...over,
})

describe('toSearchHit', () => {
  it('maps a whole-session hit to a null cursor', () => {
    expect(toSearchHit(hit())).toEqual({
      sessionId: 42,
      title: 'Debugging the backfill',
      project: 'mind-meld',
      projectPath: '/p/mind-meld',
      source: 'claude_code',
      date: '2026-01-01T00:00:00.000Z',
      score: 0.5,
      matchedTier: 'session',
      snippet: 'we fixed **NaN** embeddings',
      cursor: null,
    })
  })

  it('carries a chunk cursor through', () => {
    const dto = toSearchHit(hit({ matched_tier: 'chunk', cursor: { chunk_index: 3 } }))
    expect(dto.cursor).toEqual({ chunkIndex: 3 })
  })

  it('carries a message cursor through', () => {
    const dto = toSearchHit(hit({ matched_tier: 'message', cursor: { message_id: 900 } }))
    expect(dto.cursor).toEqual({ messageId: 900 })
  })

  // A hit with no date used to serialise as an Invalid Date string.
  it('nulls an unparseable date rather than emitting one', () => {
    const dto = toSearchHit(hit({ date: new Date('nonsense') }))
    expect(dto.date).toBeNull()
  })
})

describe('toDigest', () => {
  const digest: SessionDigest = {
    session_id: 42,
    project_id: 7,
    title: 'A session',
    summary: 'a summary',
    excerpt: null,
    project: 'mind-meld',
    message_count: 10,
    date: new Date('2026-01-01T00:00:00Z'),
    tokens: 100,
    chunks: [{ index: 0, summary: 'opening', start_message_id: 1, end_message_id: 9, chars: 500 }],
    chunk_offset: 0,
    total_chunks: 2,
  }

  it('renames the manifest fields without losing the range', () => {
    const dto = toDigest(digest)
    expect(dto.chunks[0]).toEqual({
      index: 0,
      summary: 'opening',
      startMessageId: 1,
      endMessageId: 9,
      chars: 500,
    })
    expect(dto.totalChunks).toBe(2)
    expect(dto.projectId).toBe(7)
  })
})

describe('toMessages', () => {
  const page = (over: Partial<MessagesResult> = {}): MessagesResult => ({
    session_id: 42,
    items: [{ truncated: false, message: message() }],
    range: { kind: 'window', offset: 0, limit: 30 },
    fetched: 1,
    shown: 1,
    budget_exhausted: false,
    char_budget: 24000,
    next_offset: null,
    next_start_message_id: null,
    ...over,
  })

  it('gives whole and truncated items the same shape', () => {
    const dto = toMessages(
      page({
        items: [
          { truncated: false, message: message() },
          {
            truncated: true,
            id: 8,
            role: 'assistant',
            tool_name: 'Bash',
            char_count: 271000,
            preview: 'first bytes',
          },
        ],
        shown: 2,
        fetched: 2,
      })
    )

    expect(Object.keys(dto.messages[0]).sort()).toEqual(Object.keys(dto.messages[1]).sort())
    expect(dto.messages[0]).toMatchObject({ id: 7, text: 'hello', chars: 5, truncated: false })
    // chars is the TRUE length even though text holds only the preview.
    expect(dto.messages[1]).toMatchObject({
      id: 8,
      text: 'first bytes',
      chars: 271000,
      truncated: true,
      toolName: 'Bash',
    })
  })

  it('surfaces the continuation cursor', () => {
    expect(toMessages(page({ next_offset: 30 })).nextOffset).toBe(30)
    expect(toMessages(page({ next_start_message_id: 91 })).nextStartMessageId).toBe(91)
  })
})

describe('toMessage', () => {
  it('reports zero chars for an empty body rather than null', () => {
    const dto = toMessage(message({ content_text: null }))
    expect(dto.text).toBe('')
    expect(dto.chars).toBe(0)
    expect(dto.truncated).toBe(false)
  })

  // pg hands bigint ids back as strings; the DTO must be numeric.
  it('coerces a string id to a number', () => {
    const dto = toMessage(message({ id: '7' as unknown as number }))
    expect(dto.id).toBe(7)
  })
})
