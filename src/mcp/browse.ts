// Read models for the browsing UI in public/. Search answers "what is relevant";
// these answer "what is in there" — the project/session inventory you page
// through when you have no query yet.

import { query } from '../db/postgres.js'
import { UNKNOWN_MACHINE } from './machines.js'
import { resolveTitle, type TitleSource } from './title.js'

export type ProjectSummary = {
  id: number
  name: string | null
  path: string | null
  source: string
  machine: string
  sessions: number
  messages: number
  lastActivityAt: string | null
}

type ProjectRow = {
  id: number
  name: string | null
  path: string | null
  source: string
  machine: string
  sessions: string
  messages: string
  last_activity_at: string | null
}

// Automated sessions are counted like any other here: this is an inventory of
// what was indexed, not a relevance ranking.
export const listProjects = async (): Promise<ProjectSummary[]> => {
  const result = await query<ProjectRow>(
    `SELECT p.id, p.name, p.path, src.name AS source,
            COALESCE(p.machine, $1) AS machine,
            COUNT(DISTINCT s.id) AS sessions,
            COALESCE(SUM(s.message_count), 0) AS messages,
            MAX(s.started_at) AS last_activity_at
     FROM projects p
     JOIN sources src ON src.id = p.source_id
     LEFT JOIN sessions s ON s.project_id = p.id AND s.deleted_at IS NULL
     GROUP BY p.id, p.name, p.path, src.name, COALESCE(p.machine, $1)
     ORDER BY last_activity_at DESC NULLS LAST, p.id DESC`,
    [UNKNOWN_MACHINE]
  )

  return result.rows.map(r => ({
    id: r.id,
    name: r.name,
    path: r.path,
    source: r.source,
    machine: r.machine,
    sessions: Number(r.sessions),
    messages: Number(r.messages),
    lastActivityAt: r.last_activity_at,
  }))
}

export type SessionListItem = {
  id: number
  // Resolved from the summary when the source supplied no title; null rather
  // than a fabricated one when neither exists (issue #95).
  title: string | null
  titleSource: TitleSource
  summary: string | null
  project: string | null
  projectId: number
  source: string
  machine: string
  messageCount: number
  chunkCount: number
  isAutomated: boolean
  startedAt: string | null
  lastSyncedAt: string | null
}

export type SessionListFilter = {
  limit: number
  offset: number
  projectId?: number
  source?: string
  machine?: string
  q?: string
  includeAutomated?: boolean
}

type SessionListRow = {
  id: number
  title: string | null
  summary: string | null
  project: string | null
  project_id: number
  source: string
  machine: string
  message_count: number | null
  chunk_count: string
  is_automated: boolean
  started_at: string | null
  last_synced_at: string | null
  total: string
}

// Summaries come back whole — the caller pages rather than reading a cut one
// (see the No Truncation Policy in CLAUDE.md).
export const listSessions = async (
  filter: SessionListFilter
): Promise<{ items: SessionListItem[]; total: number }> => {
  const clauses = ['s.deleted_at IS NULL']
  const params: unknown[] = [UNKNOWN_MACHINE]

  const add = (sql: string, value: unknown) => {
    params.push(value)
    clauses.push(sql.replace('?', `$${params.length}`))
  }

  if (filter.projectId !== undefined) add('s.project_id = ?', filter.projectId)
  if (filter.source) add('src.name = ?', filter.source)
  if (filter.machine) add('COALESCE(p.machine, $1) = ?', filter.machine)
  if (filter.q) {
    params.push(`%${filter.q}%`)
    const p = `$${params.length}`
    clauses.push(`(s.title ILIKE ${p} OR p.name ILIKE ${p})`)
  }
  if (!filter.includeAutomated) clauses.push('s.is_automated = false')

  params.push(filter.limit, filter.offset)
  const limitParam = `$${params.length - 1}`
  const offsetParam = `$${params.length}`

  const result = await query<SessionListRow>(
    `SELECT s.id, s.title, s.summary, p.name AS project, s.project_id,
            src.name AS source, COALESCE(p.machine, $1) AS machine,
            s.message_count, s.is_automated, s.started_at, s.last_synced_at,
            (SELECT COUNT(*) FROM session_chunks c WHERE c.session_id = s.id) AS chunk_count,
            COUNT(*) OVER() AS total
     FROM sessions s
     JOIN projects p ON p.id = s.project_id
     JOIN sources src ON src.id = p.source_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY s.started_at DESC NULLS LAST, s.id DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params
  )

  return {
    total: result.rows[0] ? Number(result.rows[0].total) : 0,
    items: result.rows.map(r => ({
      id: r.id,
      ...resolveTitle(r),
      summary: r.summary,
      project: r.project,
      projectId: r.project_id,
      source: r.source,
      machine: r.machine,
      messageCount: Number(r.message_count ?? 0),
      chunkCount: Number(r.chunk_count),
      isAutomated: r.is_automated,
      startedAt: r.started_at,
      lastSyncedAt: r.last_synced_at,
    })),
  }
}

export type ActivityDay = {
  day: string
  sessions: number
  messages: number
}

// Sessions and messages per day, oldest first, with empty days filled in so a
// gap in indexing reads as a gap rather than as a missing bar.
export const getActivity = async (days: number): Promise<ActivityDay[]> => {
  const result = await query<{ day: string; sessions: string; messages: string }>(
    `WITH span AS (
       SELECT generate_series(
         (CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day')::date,
         CURRENT_DATE,
         INTERVAL '1 day'
       )::date AS day
     )
     SELECT to_char(span.day, 'YYYY-MM-DD') AS day,
            COUNT(s.id) AS sessions,
            COALESCE(SUM(s.message_count), 0) AS messages
     FROM span
     LEFT JOIN sessions s
       ON s.started_at >= span.day
      AND s.started_at < span.day + INTERVAL '1 day'
      AND s.deleted_at IS NULL
     GROUP BY span.day
     ORDER BY span.day ASC`,
    [days]
  )

  return result.rows.map(r => ({
    day: r.day,
    sessions: Number(r.sessions),
    messages: Number(r.messages),
  }))
}
