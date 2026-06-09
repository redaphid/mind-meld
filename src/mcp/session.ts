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
  chunks: ChunkManifestEntry[]
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

const buildManifest = async (sessionId: number): Promise<ChunkManifestEntry[]> => {
  const result = await query<{
    chunk_index: number
    summary: string
    start_message_id: number
    end_message_id: number
    content_chars: number
  }>(
    `SELECT chunk_index, summary, start_message_id, end_message_id, content_chars
     FROM session_chunks
     WHERE session_id = $1
     ORDER BY chunk_index ASC`,
    [sessionId]
  )
  return result.rows.map((r) => ({
    index: r.chunk_index,
    summary: r.summary,
    start_message_id: r.start_message_id,
    end_message_id: r.end_message_id,
    chars: r.content_chars,
  }))
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
  excerpt: string | null
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
})

// The digest is the middle rung: a session's summary plus a manifest of its
// chunks, each carrying the message-id range a caller can hand to getMessages.
// No raw messages — that's getMessages' job.
export const getSessionDigest = async (
  params: { sessionId?: number; searchTerm?: string }
): Promise<SessionDigest | null> => {
  const metadata = params.sessionId
    ? await findById(params.sessionId)
    : params.searchTerm
      ? await findByTerm(params.searchTerm)
      : null
  if (!metadata) return null

  const chunks = await buildManifest(metadata.id)
  // Excerpt only matters when the summary is missing. Prefer the first chunk
  // summary (always present for chunked sessions); else the first message.
  const excerpt = metadata.summary
    ? null
    : buildExcerpt(chunks[0]?.summary ?? (await firstMessageText(metadata.id)))
  return toDigest(metadata, chunks, excerpt)
}

export type GetMessagesParams = {
  session_id?: number
  offset?: number
  limit?: number
  start_message_id?: number
  end_message_id?: number
  maxChars?: number
}

export type MessagesResult = {
  session_id: number
  messages: SessionMessage[]
  range:
    | { kind: 'window'; offset: number; limit: number }
    | { kind: 'message_ids'; start_message_id: number; end_message_id: number }
}

const sessionIdForMessage = async (messageId: number): Promise<number | null> => {
  const result = await query<{ session_id: number }>(
    `SELECT session_id FROM messages WHERE id = $1`,
    [messageId]
  )
  return result.rows[0]?.session_id ?? null
}

const capByChars = (messages: SessionMessage[], maxChars?: number): SessionMessage[] => {
  if (maxChars == null) return messages
  let used = 0
  const kept: SessionMessage[] = []
  for (const m of messages) {
    used += m.content_text?.length ?? 0
    if (kept.length > 0 && used > maxChars) break
    kept.push(m)
  }
  return kept
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
  if (params.start_message_id != null || params.end_message_id != null) {
    assert(
      params.start_message_id != null && params.end_message_id != null,
      'start_message_id and end_message_id must be provided together'
    )
    const sessionId =
      params.session_id ?? (await sessionIdForMessage(params.start_message_id))
    if (sessionId == null) return null
    const messages = await readRange(sessionId, params.start_message_id, params.end_message_id)
    return {
      session_id: sessionId,
      messages: capByChars(messages, params.maxChars),
      range: {
        kind: 'message_ids',
        start_message_id: params.start_message_id,
        end_message_id: params.end_message_id,
      },
    }
  }

  assert(params.session_id != null, 'session_id is required for windowed reads')
  const offset = params.offset ?? 0
  const limit = params.limit ?? DEFAULT_MESSAGE_LIMIT
  const messages = await readWindow(params.session_id, offset, limit)
  return {
    session_id: params.session_id,
    messages: capByChars(messages, params.maxChars),
    range: { kind: 'window', offset, limit },
  }
}

export const getChunk = async (
  params: { session_id: number; chunk_index: number }
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
    [params.session_id, params.chunk_index]
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
_No chunk manifest — read the whole thread with getMessages({ session_id: ${d.session_id} })._`

  const map = d.chunks
    .map(
      (c) =>
        `- **[${c.index}]** (msgs ${c.start_message_id}–${c.end_message_id}, ${c.chars} chars)\n  ${c.summary.replace(/\s+/g, ' ').trim()}`
    )
    .join('\n')

  return `${header}
## Chunks

Read a region with \`getMessages({ start_message_id, end_message_id })\`.

${map}`
}

export const formatMessages = (result: MessagesResult): string => {
  const { messages, range } = result
  const rangeInfo =
    range.kind === 'window'
      ? `messages ${range.offset + 1}–${range.offset + messages.length} (offset ${range.offset}, limit ${range.limit})`
      : `messages in id range ${range.start_message_id}–${range.end_message_id}`

  const header = `**Session ${result.session_id}** — ${rangeInfo}\n\n---\n\n`

  const body = messages
    .map((m) => {
      const roleLabel =
        m.role === 'user' ? '**User:**' : m.role === 'assistant' ? '**Claude:**' : `**${m.role}:**`
      const toolLabel = m.tool_name ? ` [Tool: ${m.tool_name}]` : ''
      const modelLabel = m.model ? ` [${m.model}]` : ''
      const content = m.content_text ?? '[No content]'
      return `${roleLabel}${toolLabel}${modelLabel}\n${content}`
    })
    .join('\n\n---\n\n')

  return header + body
}

export const formatChunk = (c: ChunkManifestEntry, sessionId: number): string =>
  `**Chunk [${c.index}]** of session ${sessionId} (msgs ${c.start_message_id}–${c.end_message_id}, ${c.chars} chars)

${c.summary}

---
Read the raw region: \`getMessages({ start_message_id: ${c.start_message_id}, end_message_id: ${c.end_message_id} })\``
