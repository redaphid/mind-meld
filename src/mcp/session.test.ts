import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const { getSessionDigest, getMessages } = await import('./session.js')

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

describe('getSessionDigest', () => {
  it('builds a digest with a chunk manifest from session_chunks', async () => {
    query
      .mockResolvedValueOnce(rows(metadataRow))
      .mockResolvedValueOnce(
        rows(
          {
            chunk_index: 0,
            summary: 'opening',
            start_message_id: 100,
            end_message_id: 140,
            content_chars: 5000,
          },
          {
            chunk_index: 1,
            summary: 'the fix',
            start_message_id: 141,
            end_message_id: 180,
            content_chars: 4200,
          }
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

  it('returns an empty manifest when a session has no chunks', async () => {
    query.mockResolvedValueOnce(rows(metadataRow)).mockResolvedValueOnce(rows())
    const digest = await getSessionDigest({ sessionId: 42 })
    expect(digest!.chunks).toEqual([])
  })

  it('returns null when the session does not exist', async () => {
    query.mockResolvedValueOnce(rows())
    expect(await getSessionDigest({ sessionId: 999 })).toBeNull()
  })
})

describe('getMessages', () => {
  const msg = (id: number, content: string) => ({
    id,
    sequence_num: id,
    role: 'user',
    content_text: content,
    tool_name: null,
    timestamp: new Date(),
    model: null,
  })

  it('reads a window with a default limit (never the whole thread)', async () => {
    query.mockResolvedValueOnce(rows(msg(1, 'a'), msg(2, 'b')))
    const result = await getMessages({ session_id: 42 })
    expect(result!.range).toEqual({ kind: 'window', offset: 0, limit: 30 })
    const limitArg = query.mock.calls[0][1] as unknown[]
    expect(limitArg).toEqual([42, 0, 30])
  })

  it('reads a chunk region by message-id range', async () => {
    query.mockResolvedValueOnce(rows(msg(100, 'x'), msg(101, 'y')))
    const result = await getMessages({ session_id: 42, start_message_id: 100, end_message_id: 140 })
    expect(result!.range).toEqual({
      kind: 'message_ids',
      start_message_id: 100,
      end_message_id: 140,
    })
  })

  it('caps a window by maxChars but always returns at least one message', async () => {
    query.mockResolvedValueOnce(rows(msg(1, 'x'.repeat(100)), msg(2, 'y'.repeat(100))))
    const result = await getMessages({ session_id: 42, maxChars: 10 })
    expect(result!.messages).toHaveLength(1)
  })

  it('crashes when only one end of a message-id range is given', async () => {
    await expect(getMessages({ session_id: 42, start_message_id: 100 })).rejects.toThrow()
  })
})
