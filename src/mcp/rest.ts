// The REST surface speaks one dialect: camelCase keys, one flat shape per
// resource, `{ status, <resource> }` envelopes. Internally the search and
// session modules hand back SQL-shaped snake_case rows shared with the MCP
// tools; these mappers are the single seam between the two, so the HTTP
// contract can stay stable while the query layer evolves.

import type { SearchResult } from './search.js'
import type { SessionDigest, MessagesResult, RenderedMessage, SessionMessage } from './session.js'

export type SearchHitDto = {
  sessionId: number
  title: string
  project: string
  projectPath: string | null
  source: string
  date: string | null
  score: number
  matchedTier: 'session' | 'chunk' | 'message'
  snippet: string | null
  // Where in the session the match landed, so a client can open the thread at
  // the matched region instead of at the top. Null when the hit is the session
  // as a whole.
  cursor: { chunkIndex: number } | { messageId: number } | null
}

const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export const toSearchHit = (r: SearchResult): SearchHitDto => ({
  sessionId: r.session_id,
  title: r.title,
  project: r.project_name,
  projectPath: r.project_path ?? null,
  source: r.source,
  date: iso(r.date),
  score: r.score,
  matchedTier: r.matched_tier,
  snippet: r.snippet,
  cursor:
    r.cursor?.chunk_index != null
      ? { chunkIndex: r.cursor.chunk_index }
      : r.cursor?.message_id != null
        ? { messageId: r.cursor.message_id }
        : null,
})

export type ChunkDto = {
  index: number
  summary: string
  startMessageId: number
  endMessageId: number
  chars: number
}

export type DigestDto = {
  sessionId: number
  projectId: number
  project: string
  title: string | null
  summary: string | null
  excerpt: string | null
  messageCount: number
  date: string | null
  tokens: number
  chunks: ChunkDto[]
  chunkOffset: number
  totalChunks: number
}

export const toDigest = (d: SessionDigest): DigestDto => ({
  sessionId: d.session_id,
  projectId: d.project_id,
  project: d.project,
  title: d.title,
  summary: d.summary,
  excerpt: d.excerpt,
  messageCount: d.message_count,
  date: iso(d.date),
  tokens: d.tokens,
  chunks: d.chunks.map(c => ({
    index: c.index,
    summary: c.summary,
    startMessageId: c.start_message_id,
    endMessageId: c.end_message_id,
    chars: c.chars,
  })),
  chunkOffset: d.chunk_offset,
  totalChunks: d.total_chunks,
})

// Every item has the same fields whether or not it was cut, so a client never
// branches on shape — only on the `truncated` flag. `chars` is always the true
// length of the message; when truncated, `text` holds the first `text.length`
// of them and GET /api/messages/{id} returns the rest.
export type MessageDto = {
  id: number
  role: string
  text: string
  chars: number
  truncated: boolean
  toolName: string | null
  model: string | null
  timestamp: string | null
  sequenceNum: number | null
}

export const toMessage = (m: SessionMessage): MessageDto => ({
  id: Number(m.id),
  role: m.role,
  text: m.content_text ?? '',
  chars: m.content_text?.length ?? 0,
  truncated: false,
  toolName: m.tool_name,
  model: m.model,
  timestamp: iso(m.timestamp),
  sequenceNum: m.sequence_num ?? null,
})

const toItem = (item: RenderedMessage): MessageDto =>
  item.truncated
    ? {
        id: Number(item.id),
        role: item.role,
        text: item.preview,
        chars: item.char_count,
        truncated: true,
        toolName: item.tool_name,
        model: null,
        timestamp: null,
        sequenceNum: null,
      }
    : toMessage(item.message)

export type MessagesDto = {
  sessionId: number
  messages: MessageDto[]
  fetched: number
  shown: number
  charBudget: number
  budgetExhausted: boolean
  // Whichever cursor applies to the read that produced this page; both null
  // when there is nothing further to read.
  nextOffset: number | null
  nextStartMessageId: number | null
}

export const toMessages = (r: MessagesResult): MessagesDto => ({
  sessionId: r.session_id,
  messages: r.items.map(toItem),
  fetched: r.fetched,
  shown: r.shown,
  charBudget: r.char_budget,
  budgetExhausted: r.budget_exhausted,
  nextOffset: r.next_offset,
  nextStartMessageId: r.next_start_message_id,
})
