import { describe, it, expect } from 'vitest'
import { toSearchHit, toSearchResponse, toDigest, toMessages, toMessage, parseSearchShape } from './rest.js'
import type { SearchResult } from './search.js'
import type { SessionDigest, MessagesResult, SessionMessage } from './session.js'

const hit = (over: Partial<SearchResult> = {}): SearchResult => ({
  session_id: 42,
  project_name: 'mind-meld',
  project_path: '/p/mind-meld',
  source: 'claude_code',
  data_class: 'coding',
  title: 'Debugging the backfill',
  title_source: 'source',
  date: new Date('2026-01-01T00:00:00Z'),
  score: 0.5,
  matched_tier: 'session',
  snippet: 'we fixed **NaN** embeddings',
  noise_damping: null,
  evidence: [{ arm: 'session', rank: 1, cosine: 0.8 }],
  base: 0.5,
  adjustments: [],
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
  it('maps a missing project path to null', () => {
    const dto = toSearchHit(hit({ project_path: null as unknown as string }))
    expect(dto.projectPath).toBeNull()
  })

  it('maps a whole-session hit to a null cursor', () => {
    expect(toSearchHit(hit())).toEqual({
      sessionId: 42,
      title: 'Debugging the backfill',
      titleSource: 'source',
      project: 'mind-meld',
      projectPath: '/p/mind-meld',
      source: 'claude_code',
      dataClass: 'coding',
      date: '2026-01-01T00:00:00.000Z',
      score: 0.5,
      matchedTier: 'session',
      noiseDamping: null,
      snippet: 'we fixed **NaN** embeddings',
      cursor: null,
      evidence: [{ arm: 'session', rank: 1, cosine: 0.8 }],
      base: 0.5,
      adjustments: [],
    })
  })

  it('carries the noise damping through, including a clean 1', () => {
    expect(toSearchHit(hit({ noise_damping: 0.8 })).noiseDamping).toBe(0.8)
    expect(toSearchHit(hit({ noise_damping: 1 })).noiseDamping).toBe(1)
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

describe('toSearchResponse', () => {
  it('carries the list handle beside the results, whatever was found', () => {
    const full = toSearchResponse({ query: 'q', list: 'Lk3x9qa', mode: 'hybrid', outcome: { results: [hit()], degraded: null, projectIds: [], armMs: { semanticMs: null, embedMs: null, sessionMs: null, chunkMs: null, messageMs: null, fullTextMs: null } } })
    expect(full).toMatchObject({ status: 'ok', list: 'Lk3x9qa', mode: 'hybrid', count: 1 })
    expect(full.results[0].sessionId).toBe(42)
    const empty = toSearchResponse({ query: 'q', list: 'Lm2m2m2', mode: 'text', outcome: { results: [], degraded: null, projectIds: [], armMs: { semanticMs: null, embedMs: null, sessionMs: null, chunkMs: null, messageMs: null, fullTextMs: null } } })
    expect(empty).toMatchObject({ list: 'Lm2m2m2', count: 0, results: [] })
  })
})

describe('toDigest', () => {
  const digest: SessionDigest = {
    session_id: 42,
    project_id: 7,
    title: 'A session',
    title_source: 'source',
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

  // Depending on the pg type parser config, timestamps can arrive as strings.
  it('normalises a string timestamp to ISO', () => {
    const dto = toMessage(message({ timestamp: '2026-01-01T00:00:00Z' as unknown as Date }))
    expect(dto.timestamp).toBe('2026-01-01T00:00:00.000Z')
  })

  it('maps a missing timestamp to null rather than an invalid date', () => {
    const dto = toMessage(message({ timestamp: null as unknown as Date }))
    expect(dto.timestamp).toBeNull()
  })

  it('maps a missing sequence number to null', () => {
    const dto = toMessage(message({ sequence_num: null as unknown as number }))
    expect(dto.sequenceNum).toBeNull()
  })
})

describe('parseSearchShape', () => {
  it('defaults to a hybrid search of 20', () => {
    expect(parseSearchShape({})).toEqual({ mode: 'hybrid', limit: 20 })
  })

  it.each(['semantic', 'text', 'hybrid'])('accepts mode %s', (mode) => {
    expect(parseSearchShape({ mode })).toEqual({ mode, limit: 20 })
  })

  it.each(['vector', 'Hybrid', '', ['text', 'hybrid']])('rejects mode %j instead of running hybrid', (mode) => {
    expect(parseSearchShape({ mode })).toEqual({ error: 'mode must be one of semantic, text, hybrid' })
  })

  it.each(['0', '-3', '2.5', 'ten'])('rejects limit %s', (limit) => {
    expect(parseSearchShape({ limit })).toEqual({ error: 'limit must be a positive integer' })
  })

  it('caps the limit at 100', () => {
    expect(parseSearchShape({ limit: '1' })).toEqual({ mode: 'hybrid', limit: 1 })
    expect(parseSearchShape({ limit: '500' })).toEqual({ mode: 'hybrid', limit: 100 })
  })
})
