import assert from 'node:assert'
import { query } from '../db/postgres.js'
import { buildExcerpt } from './snippet.js'

export type SessionMetadata = {
  id: number
  external_id: string | null
  title: string | null
  summary: string | null
  project_name: string
  project_path: string
  source_name: string
  started_at: Date
  ended_at: Date | null
  message_count: number
  model_used: string | null
  git_branch: string | null
  total_input_tokens: number
  total_output_tokens: number
}

export type ChunkManifestEntry = {
  index: number
  summary: string
  start_message_id: number
  end_message_id: number
  chars: number
}

export type SessionDigest = {
  session_id: number
  title: string | null
  summary: string | null
  // Issue #4: present only when summary is NULL — a labeled raw-text fallback so
  // the digest is never triage-blind. Yields to the real summary once it exists.
  excerpt: string | null
  project: string
  message_count: number
  date: Date
  tokens: number
  // The manifest is itself a windowed rung: `chunks` is the slice starting at
  // `chunk_offset`, `total_chunks` is how many the session has. A 96-chunk
  // session would otherwise dump ~34K tokens of summaries in one call.
  chunks: ChunkManifestEntry[]
  chunk_offset: number
  total_chunks: number
}

export type SessionMessage = {
  id: number
  sequence_num: number
  role: string
  content_text: string | null
  tool_name: string | null
  timestamp: Date
  model: string | null
}

const DEFAULT_MESSAGE_LIMIT = 30
const DEFAULT_CHUNK_LIMIT = 20
// ~6K tokens. Keeps a normal multi-message read whole (p95 message is ~5.8K
// chars) while bounding the tail: an uncapped chunk-range read could otherwise
// return a 272K-char chunk in one call. Overridable per-call via maxChars.
const DEFAULT_CHAR_BUDGET = 24000

const SELECT_METADATA = `
  SELECT s.id, s.external_id, s.title, s.summary, p.name as project_name, p.path as project_path,
         src.name as source_name, s.started_at, s.ended_at, s.message_count,
         s.model_used, s.git_branch, s.total_input_tokens, s.total_output_tokens
  FROM sessions s
  JOIN projects p ON s.project_id = p.id
  JOIN sources src ON p.source_id = src.id`

const findById = async (sessionId: number) => {
  const result = await query<SessionMetadata>(
    `${SELECT_METADATA} WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [sessionId]
  )
  return result.rows[0] ?? null
}

const findByTerm = async (term: string) => {
  const numericId = /^\d+$/.test(term) ? parseInt(term, 10) : null
  const result = await query<SessionMetadata>(
    `${SELECT_METADATA}
     WHERE (s.id = $3 OR s.external_id = $1 OR s.title ILIKE $2)
       AND s.deleted_at IS NULL
     ORDER BY s.started_at DESC
     LIMIT 1`,
    [term, `%${term}%`, numericId]
  )
  return result.rows[0] ?? null
}

const buildManifest = async (
  sessionId: number,
  offset: number,
  limit: number
): Promise<{ chunks: ChunkManifestEntry[]; total: number }> => {
  const result = await query<{
    chunk_index: number
    summary: string
    start_message_id: number
    end_message_id: number
    content_chars: number
    total_chunks: string
  }>(
    `SELECT chunk_index, summary, start_message_id, end_message_id, content_chars,
            count(*) OVER() AS total_chunks
     FROM session_chunks
     WHERE session_id = $1
     ORDER BY chunk_index ASC
     OFFSET $2 LIMIT $3`,
    [sessionId, offset, limit]
  )
  return {
    total: result.rows[0] ? Number(result.rows[0].total_chunks) : 0,
    chunks: result.rows.map((r) => ({
      index: r.chunk_index,
      summary: r.summary,
      start_message_id: r.start_message_id,
      end_message_id: r.end_message_id,
      chars: r.content_chars,
    })),
  }
}

const firstMessageText = async (sessionId: number): Promise<string | null> => {
  const result = await query<{ content_text: string | null }>(
    `SELECT content_text FROM messages
     WHERE session_id = $1 AND content_text IS NOT NULL AND length(content_text) > 0
     ORDER BY sequence_num ASC LIMIT 1`,
    [sessionId]
  )
  return result.rows[0]?.content_text ?? null
}

const toDigest = (
  s: SessionMetadata,
  chunks: ChunkManifestEntry[],
  excerpt: string | null,
  chunkOffset: number,
  totalChunks: number
): SessionDigest => ({
  session_id: s.id,
  title: s.title,
  summary: s.summary,
  excerpt: s.summary ? null : excerpt,
  project: s.project_name,
  message_count: s.message_count,
  date: s.started_at,
  tokens: Number(s.total_input_tokens) + Number(s.total_output_tokens),
  chunks,
  chunk_offset: chunkOffset,
  total_chunks: totalChunks,
})

// The digest is the middle rung: a session's summary plus a manifest of its
// chunks, each carrying the message-id range a caller can hand to getMessages.
// No raw messages — that's getMessages' job.
export const getSessionDigest = async (
  params: { sessionId?: number; searchTerm?: string; chunkOffset?: number; chunkLimit?: number }
): Promise<SessionDigest | null> => {
  const metadata = params.sessionId
    ? await findById(params.sessionId)
    : params.searchTerm
      ? await findByTerm(params.searchTerm)
      : null
  if (!metadata) return null

  const offset = params.chunkOffset ?? 0
  const limit = params.chunkLimit ?? DEFAULT_CHUNK_LIMIT
  const { chunks, total } = await buildManifest(metadata.id, offset, limit)
  // Excerpt only matters when the summary is missing. Prefer the first chunk
  // summary (always present for chunked sessions); else the first message.
  const excerpt = metadata.summary
    ? null
    : buildExcerpt(chunks[0]?.summary ?? (await firstMessageText(metadata.id)))
  return toDigest(metadata, chunks, excerpt, offset, total)
}

export type GetMessagesParams = {
  sessionId?: number
  offset?: number
  limit?: number
  startMessageId?: number
  endMessageId?: number
  maxChars?: number
}

// A rendered message is either the full message or — when one message alone
// exceeds the call's char budget — a TRUNCATED preview. This is the single,
// explicit exception to the No Truncation Policy: the cut is labeled
// ("showing first N of M chars") and the full bytes are one getMessage call
// away, so nothing is lost silently. Truncation lives ONLY here in the read
// layer; content_text in the DB is never altered, so the summarizer and
// embedding pipelines (which read content_text straight from the DB) can never
// see a cut message.
export type RenderedMessage =
  | { truncated: false; message: SessionMessage }
  | {
      truncated: true
      id: number
      role: string
      tool_name: string | null
      char_count: number
      preview: string
    }

export type MessagesResult = {
  session_id: number
  items: RenderedMessage[]
  range:
    | { kind: 'window'; offset: number; limit: number }
    | { kind: 'message_ids'; start_message_id: number; end_message_id: number }
  fetched: number
  shown: number
  budget_exhausted: boolean
  char_budget: number
  next_offset: number | null
  next_start_message_id: number | null
}

const sessionIdForMessage = async (messageId: number): Promise<number | null> => {
  const result = await query<{ session_id: number }>(
    `SELECT session_id FROM messages WHERE id = $1`,
    [messageId]
  )
  return result.rows[0]?.session_id ?? null
}

const TRUNCATED_PREVIEW_CHARS = 2000

// The cap also never exceeds the call's own budget — a tiny maxChars must win
// over the default preview size.
const toTruncated = (m: SessionMessage, budget: number): RenderedMessage => {
  const text = m.content_text ?? ''
  const cap = Math.min(TRUNCATED_PREVIEW_CHARS, budget)
  return {
    truncated: true,
    id: m.id,
    role: m.role,
    tool_name: m.tool_name,
    char_count: text.length,
    preview: text.slice(0, cap),
  }
}

// message.id is a bigint — pg hands it back as a string, so coerce before any
// arithmetic on the paging cursor (else `id + 1` silently concatenates).
const lastItemId = (item: RenderedMessage): number =>
  Number(item.truncated ? item.id : item.message.id)

// Walk messages, keeping each whole until the budget runs out. A message larger
// than the entire budget becomes a stub (alone) or is left for the next page.
const renderWithinBudget = (
  messages: SessionMessage[],
  budget: number
): { items: RenderedMessage[]; exhausted: boolean } => {
  const items: RenderedMessage[] = []
  let used = 0
  for (const m of messages) {
    const len = m.content_text?.length ?? 0
    if (len > budget && items.length === 0) {
      items.push(toTruncated(m, budget))
      return { items, exhausted: true }
    }
    if (len > budget) return { items, exhausted: true }
    if (used + len > budget && items.length > 0) return { items, exhausted: true }
    items.push({ truncated: false, message: m })
    used += len
  }
  return { items, exhausted: false }
}

const readWindow = async (sessionId: number, offset: number, limit: number) => {
  const result = await query<SessionMessage>(
    `SELECT id, sequence_num, role, content_text, tool_name, timestamp, model
     FROM messages
     WHERE session_id = $1
     ORDER BY sequence_num ASC
     OFFSET $2
     LIMIT $3`,
    [sessionId, offset, limit]
  )
  return result.rows
}

const readRange = async (sessionId: number, startId: number, endId: number) => {
  const result = await query<SessionMessage>(
    `SELECT id, sequence_num, role, content_text, tool_name, timestamp, model
     FROM messages
     WHERE session_id = $1 AND id >= $2 AND id <= $3
     ORDER BY sequence_num ASC`,
    [sessionId, startId, endId]
  )
  return result.rows
}

// Raw, windowed message reader — the old getSession dumper. Either browse a
// window (offset/limit, default limit so we never spill the whole thread) or
// read one chunk's region by its message-id range (straight off the manifest).
export const getMessages = async (params: GetMessagesParams): Promise<MessagesResult | null> => {
  const budget = params.maxChars ?? DEFAULT_CHAR_BUDGET
  if (params.startMessageId != null || params.endMessageId != null) {
    assert(
      params.startMessageId != null && params.endMessageId != null,
      'startMessageId and endMessageId must be provided together'
    )
    const sessionId =
      params.sessionId ?? (await sessionIdForMessage(params.startMessageId))
    if (sessionId == null) return null
    const fetched = await readRange(sessionId, params.startMessageId, params.endMessageId)
    const { items, exhausted } = renderWithinBudget(fetched, budget)
    const lastId = items.length > 0 ? lastItemId(items[items.length - 1]) : null
    // Only offer a continuation when one stays inside the range — a sole
    // oversized message leaves lastId+1 past the end, which is no next page.
    const nextStart =
      exhausted && lastId != null && lastId + 1 <= params.endMessageId ? lastId + 1 : null
    return {
      session_id: sessionId,
      items,
      range: {
        kind: 'message_ids',
        start_message_id: params.startMessageId,
        end_message_id: params.endMessageId,
      },
      fetched: fetched.length,
      shown: items.length,
      budget_exhausted: exhausted,
      char_budget: budget,
      next_offset: null,
      next_start_message_id: nextStart,
    }
  }

  assert(params.sessionId != null, 'sessionId is required for windowed reads')
  const offset = params.offset ?? 0
  const limit = params.limit ?? DEFAULT_MESSAGE_LIMIT
  const fetched = await readWindow(params.sessionId, offset, limit)
  const { items, exhausted } = renderWithinBudget(fetched, budget)
  const more = exhausted || fetched.length === limit
  return {
    session_id: params.sessionId,
    items,
    range: { kind: 'window', offset, limit },
    fetched: fetched.length,
    shown: items.length,
    budget_exhausted: exhausted,
    char_budget: budget,
    next_offset: more && items.length > 0 ? offset + items.length : null,
    next_start_message_id: null,
  }
}

// The escape hatch for an oversized message: fetch exactly one by id, in full,
// uncapped. Reaching a 271K-char message requires this explicit, deliberate call
// — it can never arrive by accident through a window or range read.
export const getMessageById = async (id: number): Promise<SessionMessage | null> => {
  const result = await query<SessionMessage>(
    `SELECT id, sequence_num, role, content_text, tool_name, timestamp, model
     FROM messages
     WHERE id = $1`,
    [id]
  )
  return result.rows[0] ?? null
}

export const getChunk = async (
  params: { sessionId: number; chunkIndex: number }
): Promise<ChunkManifestEntry | null> => {
  const result = await query<{
    chunk_index: number
    summary: string
    start_message_id: number
    end_message_id: number
    content_chars: number
  }>(
    `SELECT chunk_index, summary, start_message_id, end_message_id, content_chars
     FROM session_chunks
     WHERE session_id = $1 AND chunk_index = $2`,
    [params.sessionId, params.chunkIndex]
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    index: row.chunk_index,
    summary: row.summary,
    start_message_id: row.start_message_id,
    end_message_id: row.end_message_id,
    chars: row.content_chars,
  }
}

export const formatDigest = (d: SessionDigest): string => {
  assert(d.date, `Missing date for session ${d.session_id}`)
  const summaryBlock = d.summary
    ? `## Summary\n\n${d.summary}`
    : d.excerpt
      ? `## Excerpt (no summary yet)\n\n"${d.excerpt}"`
      : `## Summary\n\nNo summary available for this session.`

  const header = `# ${d.title ?? 'Untitled Session'}

**Session ID:** ${d.session_id}
**Project:** ${d.project}
**Date:** ${d.date.toISOString().split('T')[0]}
**Messages:** ${d.message_count}
**Tokens:** ${d.tokens}

${summaryBlock}
`

  if (d.chunks.length === 0)
    return `${header}
_No chunk manifest — read the whole thread with getMessages({ sessionId: ${d.session_id} })._`

  const map = d.chunks
    .map(
      (c) =>
        `- **[${c.index}]** (msgs ${c.start_message_id}–${c.end_message_id}, ${c.chars} chars)\n  ${c.summary.replace(/\s+/g, ' ').trim()}`
    )
    .join('\n')

  const shownTo = d.chunk_offset + d.chunks.length
  const heading =
    d.total_chunks > d.chunks.length
      ? `## Chunks (${d.chunk_offset}–${shownTo - 1} of ${d.total_chunks})`
      : `## Chunks`
  const pager =
    d.total_chunks > shownTo
      ? `\n\n_More chunks — \`getSession({ sessionId: ${d.session_id}, chunkOffset: ${shownTo} })\`._`
      : ''

  return `${header}
${heading}

Each chunk is a summary of a span of messages (not one message). Read a span's raw messages with \`getMessages({ startMessageId, endMessageId })\`.

${map}${pager}`
}

const roleLabelFor = (role: string): string =>
  role === 'user' ? '**User:**' : role === 'assistant' ? '**Claude:**' : `**${role}:**`

const renderItem = (item: RenderedMessage): string => {
  if (item.truncated)
    return `${roleLabelFor(item.role)}${item.tool_name ? ` [Tool: ${item.tool_name}]` : ''} [TRUNCATED — showing first ${item.preview.length} of ${item.char_count} chars]
${item.preview}
…[truncated — read the full message with \`getMessage({ id: ${item.id} })\`]`
  const m = item.message
  const toolLabel = m.tool_name ? ` [Tool: ${m.tool_name}]` : ''
  const modelLabel = m.model ? ` [${m.model}]` : ''
  return `${roleLabelFor(m.role)}${toolLabel}${modelLabel}\n${m.content_text ?? '[No content]'}`
}

const pagingFooter = (result: MessagesResult): string => {
  if (result.next_offset != null)
    return `\n\n---\n_More messages — \`getMessages({ sessionId: ${result.session_id}, offset: ${result.next_offset} })\`._`
  if (result.next_start_message_id != null && result.range.kind === 'message_ids')
    return `\n\n---\n_Budget reached — continue: \`getMessages({ startMessageId: ${result.next_start_message_id}, endMessageId: ${result.range.end_message_id} })\`._`
  return ''
}

export const formatMessages = (result: MessagesResult): string => {
  const { items, range } = result
  const rangeInfo =
    range.kind === 'window'
      ? `window offset ${range.offset}, limit ${range.limit}`
      : `id range ${range.start_message_id}–${range.end_message_id}`

  if (items.length === 0)
    return `**Session ${result.session_id}** — ${rangeInfo}\n\nNo messages in this range.`

  const header = `**Session ${result.session_id}** — ${rangeInfo} · showing ${result.shown} of ${result.fetched} fetched (budget ${result.char_budget} chars)\n\n---\n\n`
  const body = items.map(renderItem).join('\n\n---\n\n')
  return header + body + pagingFooter(result)
}

export const formatMessage = (m: SessionMessage): string => {
  const toolLabel = m.tool_name ? ` [Tool: ${m.tool_name}]` : ''
  const modelLabel = m.model ? ` [${m.model}]` : ''
  return `${roleLabelFor(m.role)}${toolLabel}${modelLabel} **(message ${m.id}, ${m.content_text?.length ?? 0} chars)**\n\n${m.content_text ?? '[No content]'}`
}

export const formatChunk = (c: ChunkManifestEntry, sessionId: number): string =>
  `**Chunk [${c.index}]** of session ${sessionId} (msgs ${c.start_message_id}–${c.end_message_id}, ${c.chars} chars)

${c.summary}

---
Read the raw region: \`getMessages({ startMessageId: ${c.start_message_id}, endMessageId: ${c.end_message_id} })\``
