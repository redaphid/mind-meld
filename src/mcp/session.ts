import { query } from '../db/postgres.js'

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
}

export type SessionMessage = {
  sequence_num: number
  role: string
  content_text: string | null
  tool_name: string | null
  timestamp: Date
  model: string | null
}

export type GetSessionParams = {
  sessionId?: number
  searchTerm?: string
  offset?: number
  limit?: number
}

export type SessionResult = {
  metadata: SessionMetadata
  messages: SessionMessage[]
  total: number
  range: { offset: number; limit: number | null } | null
}

const findSession = async (params: GetSessionParams) => {
  if (params.sessionId) {
    const result = await query<SessionMetadata>(
      `SELECT s.id, s.external_id, s.title, s.summary, p.name as project_name, p.path as project_path,
              src.name as source_name, s.started_at, s.ended_at, s.message_count,
              s.model_used, s.git_branch
       FROM sessions s
       JOIN projects p ON s.project_id = p.id
       JOIN sources src ON p.source_id = src.id
       WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [params.sessionId]
    )
    return result.rows[0] ?? null
  }

  if (params.searchTerm) {
    const result = await query<SessionMetadata>(
      `SELECT s.id, s.external_id, s.title, s.summary, p.name as project_name, p.path as project_path,
              src.name as source_name, s.started_at, s.ended_at, s.message_count,
              s.model_used, s.git_branch
       FROM sessions s
       JOIN projects p ON s.project_id = p.id
       JOIN sources src ON p.source_id = src.id
       WHERE (s.external_id = $1 OR s.title ILIKE $2)
         AND s.deleted_at IS NULL
       ORDER BY s.started_at DESC
       LIMIT 1`,
      [params.searchTerm, `%${params.searchTerm}%`]
    )
    return result.rows[0] ?? null
  }

  return null
}

const fetchMessages = async (sessionId: number, offset?: number, limit?: number) => {
  if (offset != null || limit != null) {
    const result = await query<SessionMessage>(
      `SELECT sequence_num, role, content_text, tool_name, timestamp, model
       FROM messages
       WHERE session_id = $1
       ORDER BY sequence_num ASC
       OFFSET $2
       LIMIT $3`,
      [sessionId, offset ?? 0, limit ?? 2147483647]
    )
    return result.rows
  }

  const result = await query<SessionMessage>(
    `SELECT sequence_num, role, content_text, tool_name, timestamp, model
     FROM messages
     WHERE session_id = $1
     ORDER BY sequence_num ASC`,
    [sessionId]
  )
  return result.rows
}

export const getSession = async (params: GetSessionParams): Promise<SessionResult | null> => {
  const metadata = await findSession(params)
  if (!metadata) return null

  const messages = await fetchMessages(metadata.id, params.offset, params.limit)
  const isPaginated = params.offset != null || params.limit != null

  return {
    metadata,
    messages,
    total: metadata.message_count,
    range: isPaginated ? { offset: params.offset ?? 0, limit: params.limit ?? null } : null,
  }
}

export const formatSession = (result: SessionResult) => {
  const { metadata: s, messages, total, range } = result

  const rangeInfo = range
    ? `\n**Showing:** messages ${range.offset + 1}-${range.offset + messages.length} of ${total}`
    : ''

  const header = `# ${s.title ?? 'Untitled Session'}

**Project:** ${s.project_name}
**Path:** ${s.project_path}
**Source:** ${s.source_name}
**Model:** ${s.model_used ?? 'Unknown'}
**Branch:** ${s.git_branch ?? 'N/A'}
**Date:** ${s.started_at?.toISOString().split('T')[0] ?? 'Unknown'}
**Messages:** ${total}${rangeInfo}

---

## Summary

${s.summary ?? 'No summary available for this session.'}

---
`

  const body = messages.map((m) => {
    const roleLabel = m.role === 'user' ? '**User:**' : m.role === 'assistant' ? '**Claude:**' : `**${m.role}:**`
    const toolLabel = m.tool_name ? ` [Tool: ${m.tool_name}]` : ''
    const modelLabel = m.model ? ` [${m.model}]` : ''
    const content = m.content_text ?? '[No content]'
    return `${roleLabel}${toolLabel}${modelLabel}\n${content}`
  }).join('\n\n---\n\n')

  return header + body
}
