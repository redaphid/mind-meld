import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const { getSessionDigest, getMessages, getMessageById, formatMessages, formatDigest } =
  await import('./session.js')

type Row = Record<string, unknown>
const rows = (...r: Row[]) => ({ rows: r })

beforeEach(() => {
  query.mockReset()
})

const metadataRow = {
  id: 42,
  external_id: 'ext-42',
  title: 'Debugging the backfill',
  summary: 'We fixed NaN embeddings.',
  project_name: 'mind-meld',
  project_path: '/p/mind-meld',
  source_name: 'claude_code',
  started_at: new Date('2026-01-01T00:00:00Z'),
  ended_at: null,
  message_count: 120,
  model_used: 'opus',
  git_branch: 'main',
  total_input_tokens: '1000',
  total_output_tokens: '500',
}

const chunkRow = (over: Row): Row => ({
  chunk_index: 0,
  summary: 'opening',
  start_message_id: 100,
  end_message_id: 140,
  content_chars: 5000,
  total_chunks: '2',
  ...over,
})

describe('getSessionDigest', () => {
  it('builds a digest with a chunk manifest from session_chunks', async () => {
    query
      .mockResolvedValueOnce(rows(metadataRow))
      .mockResolvedValueOnce(
        rows(
          chunkRow({ chunk_index: 0, summary: 'opening', content_chars: 5000 }),
          chunkRow({
            chunk_index: 1,
            summary: 'the fix',
            start_message_id: 141,
            end_message_id: 180,
            content_chars: 4200,
          })
        )
      )

    const digest = await getSessionDigest({ sessionId: 42 })
    expect(digest).not.toBeNull()
    expect(digest!.tokens).toBe(1500)
    expect(digest!.project).toBe('mind-meld')
    expect(digest!.chunks).toEqual([
      { index: 0, summary: 'opening', start_message_id: 100, end_message_id: 140, chars: 5000 },
      { index: 1, summary: 'the fix', start_message_id: 141, end_message_id: 180, chars: 4200 },
    ])
  })

  it('reports total_chunks from the windowed manifest count', async () => {
    query
      .mockResolvedValueOnce(rows(metadataRow))
      .mockResolvedValueOnce(rows(chunkRow({ total_chunks: '96' })))
    const digest = await getSessionDigest({ sessionId: 42 })
    expect(digest!.total_chunks).toBe(96)
  })

  it('defaults the manifest window to offset 0, limit 20', async () => {
    query.mockResolvedValueOnce(rows(metadataRow)).mockResolvedValueOnce(rows(chunkRow({})))
    await getSessionDigest({ sessionId: 42 })
    expect(query.mock.calls[1][1]).toEqual([42, 0, 20])
  })

  it('pages the manifest with chunkOffset and chunkLimit', async () => {
    query.mockResolvedValueOnce(rows(metadataRow)).mockResolvedValueOnce(rows(chunkRow({})))
    await getSessionDigest({ sessionId: 42, chunkOffset: 20, chunkLimit: 5 })
    expect(query.mock.calls[1][1]).toEqual([42, 20, 5])
  })

  it('returns an empty manifest when a session has no chunks', async () => {
    query.mockResolvedValueOnce(rows(metadataRow)).mockResolvedValueOnce(rows())
    const digest = await getSessionDigest({ sessionId: 42 })
    expect(digest!.chunks).toEqual([])
  })

  it('reports zero total_chunks when a session has no chunks', async () => {
    query.mockResolvedValueOnce(rows(metadataRow)).mockResolvedValueOnce(rows())
    const digest = await getSessionDigest({ sessionId: 42 })
    expect(digest!.total_chunks).toBe(0)
  })

  it('returns null when the session does not exist', async () => {
    query.mockResolvedValueOnce(rows())
    expect(await getSessionDigest({ sessionId: 999 })).toBeNull()
  })

  it('has no excerpt when a real summary is present (#4)', async () => {
    query.mockResolvedValueOnce(rows(metadataRow)).mockResolvedValueOnce(rows(chunkRow({})))
    const digest = await getSessionDigest({ sessionId: 42 })
    expect(digest!.summary).toBe('We fixed NaN embeddings.')
    expect(digest!.excerpt).toBeNull()
  })

  it('falls back to the first chunk summary as an excerpt when summary is NULL (#4)', async () => {
    query
      .mockResolvedValueOnce(rows({ ...metadataRow, summary: null }))
      .mockResolvedValueOnce(
        rows(chunkRow({ summary: 'set OLLAMA_FLASH_ATTENTION false to stop NaN embeddings' }))
      )
    const digest = await getSessionDigest({ sessionId: 42 })
    expect(digest!.summary).toBeNull()
    expect(digest!.excerpt).toBe('set OLLAMA_FLASH_ATTENTION false to stop NaN embeddings')
  })

  it('falls back to the first message when summary is NULL and there are no chunks (#4)', async () => {
    query
      .mockResolvedValueOnce(rows({ ...metadataRow, summary: null }))
      .mockResolvedValueOnce(rows())
      .mockResolvedValueOnce(rows({ content_text: 'first user message that hints at the topic' }))
    const digest = await getSessionDigest({ sessionId: 42 })
    expect(digest!.excerpt).toBe('first user message that hints at the topic')
  })
})

describe('formatDigest', () => {
  const baseDigest = {
    session_id: 42,
    title: 'A session',
    summary: 'a summary',
    excerpt: null,
    project: 'mind-meld',
    message_count: 10,
    date: new Date('2026-01-01T00:00:00Z'),
    tokens: 100,
  }

  it('shows a pager when more chunks remain than were returned', () => {
    const text = formatDigest({
      ...baseDigest,
      chunk_offset: 0,
      total_chunks: 96,
      chunks: [{ index: 0, summary: 's', start_message_id: 1, end_message_id: 9, chars: 10 }],
    })
    expect(text).toContain('getSession({ sessionId: 42, chunkOffset: 1 })')
  })

  it('shows no pager when all chunks fit', () => {
    const text = formatDigest({
      ...baseDigest,
      chunk_offset: 0,
      total_chunks: 1,
      chunks: [{ index: 0, summary: 's', start_message_id: 1, end_message_id: 9, chars: 10 }],
    })
    expect(text).not.toContain('chunkOffset')
  })
})

describe('getMessages', () => {
  const msg = (id: number, content: string) => ({
    id,
    sequence_num: id,
    role: 'user',
    content_text: content,
    tool_name: null,
    timestamp: new Date('2026-01-01T00:00:00Z'),
    model: null,
  })

  it('reads a window with a default limit (never the whole thread)', async () => {
    query.mockResolvedValueOnce(rows(msg(1, 'a'), msg(2, 'b')))
    const result = await getMessages({ sessionId: 42 })
    expect(result!.range).toEqual({ kind: 'window', offset: 0, limit: 30 })
    expect(query.mock.calls[0][1]).toEqual([42, 0, 30])
  })

  it('returns whole messages that fit under the budget', async () => {
    query.mockResolvedValueOnce(rows(msg(1, 'a'), msg(2, 'b')))
    const result = await getMessages({ sessionId: 42 })
    expect(result!.items).toEqual([
      { truncated: false, message: msg(1, 'a') },
      { truncated: false, message: msg(2, 'b') },
    ])
  })

  it('reads a chunk region by message-id range', async () => {
    query.mockResolvedValueOnce(rows(msg(100, 'x'), msg(101, 'y')))
    const result = await getMessages({ sessionId: 42, startMessageId: 100, endMessageId: 140 })
    expect(result!.range).toEqual({
      kind: 'message_ids',
      start_message_id: 100,
      end_message_id: 140,
    })
  })

  it('stops at the budget and reports the next window offset', async () => {
    query.mockResolvedValueOnce(rows(msg(1, 'x'.repeat(80)), msg(2, 'y'.repeat(80))))
    const result = await getMessages({ sessionId: 42, maxChars: 100 })
    expect(result!.shown).toBe(1)
    expect(result!.budget_exhausted).toBe(true)
    expect(result!.next_offset).toBe(1)
  })

  it('truncates a single message larger than the whole budget instead of dumping it', async () => {
    query.mockResolvedValueOnce(rows(msg(7, 'z'.repeat(500))))
    const result = await getMessages({ sessionId: 42, maxChars: 100 })
    expect(result!.items).toHaveLength(1)
    expect(result!.items[0]).toEqual(
      expect.objectContaining({ truncated: true, id: 7, char_count: 500 })
    )
  })

  it('caps the truncated preview at the call budget, never past it', async () => {
    query.mockResolvedValueOnce(rows(msg(7, 'z'.repeat(500))))
    const result = await getMessages({ sessionId: 42, maxChars: 100 })
    const item = result!.items[0]
    expect(item.truncated && item.preview.length).toBe(100)
  })

  it('points past an oversized message so a range read can continue', async () => {
    query.mockResolvedValueOnce(rows(msg(7, 'z'.repeat(500))))
    const result = await getMessages({
      sessionId: 42,
      startMessageId: 7,
      endMessageId: 9,
      maxChars: 100,
    })
    expect(result!.next_start_message_id).toBe(8)
  })

  it('offers no continuation when the sole oversized message ends the range', async () => {
    query.mockResolvedValueOnce(rows(msg(7, 'z'.repeat(500))))
    const result = await getMessages({
      sessionId: 42,
      startMessageId: 7,
      endMessageId: 7,
      maxChars: 100,
    })
    expect(result!.next_start_message_id).toBeNull()
  })

  it('leaves an oversized message for the next page when earlier messages were shown', async () => {
    query.mockResolvedValueOnce(rows(msg(5, 'small'), msg(6, 'z'.repeat(500))))
    const result = await getMessages({
      sessionId: 42,
      startMessageId: 5,
      endMessageId: 9,
      maxChars: 100,
    })
    expect(result!.shown).toBe(1)
    expect(result!.items[0]).toEqual({ truncated: false, message: msg(5, 'small') })
    expect(result!.next_start_message_id).toBe(6)
  })

  it('crashes when only one end of a message-id range is given', async () => {
    await expect(getMessages({ sessionId: 42, startMessageId: 100 })).rejects.toThrow()
  })
})

describe('formatMessages', () => {
  const truncatedResult = {
    session_id: 42,
    items: [
      { truncated: true as const, id: 7, role: 'assistant', tool_name: null, char_count: 9000, preview: 'the first part' },
    ],
    range: { kind: 'window' as const, offset: 0, limit: 30 },
    fetched: 1,
    shown: 1,
    budget_exhausted: true,
    char_budget: 24000,
    next_offset: null,
    next_start_message_id: null,
  }

  it('labels a truncated message as TRUNCATED with both counts', () => {
    expect(formatMessages(truncatedResult)).toContain('TRUNCATED — showing first 14 of 9000 chars')
  })

  it('shows the preview text of a truncated message', () => {
    expect(formatMessages(truncatedResult)).toContain('the first part')
  })

  it('points to getMessage for the full truncated message', () => {
    expect(formatMessages(truncatedResult)).toContain('getMessage({ id: 7 })')
  })
})

describe('getMessageById', () => {
  it('returns the single message in full', async () => {
    query.mockResolvedValueOnce(
      rows({
        id: 7,
        sequence_num: 7,
        role: 'assistant',
        content_text: 'the whole thing',
        tool_name: null,
        timestamp: new Date('2026-01-01T00:00:00Z'),
        model: 'opus',
      })
    )
    const message = await getMessageById(7)
    expect(message!.content_text).toBe('the whole thing')
  })

  it('returns null when the message does not exist', async () => {
    query.mockResolvedValueOnce(rows())
    expect(await getMessageById(999)).toBeNull()
  })
})
