// Which computer indexed what, and when. Several machines sync into one
// database; projects.machine records the origin (see init-db/016-machine.sql).
// This is read from the DB rather than the process log buffer, so the MCP
// container can report on sync work done by containers it cannot see.

import { query } from '../db/postgres.js'

// Projects that predate the machine column, or arrived via /api/ingest without
// a declared sender, group under this name rather than being silently dropped.
export const UNKNOWN_MACHINE = 'unknown'

export type MachineActivity = {
  machine: string
  projects: number
  sessions: number
  messages: number
  lastIndexedAt: string | null
  lastSession: {
    id: number
    title: string | null
    project: string | null
    syncedAt: string | null
  } | null
}

type ActivityRow = {
  machine: string
  projects: string
  sessions: string
  messages: string
  last_indexed_at: string | null
  last_session_id: number | null
  last_session_title: string | null
  last_session_project: string | null
  last_session_synced_at: string | null
}

// GREATEST ignores NULLs in Postgres, so a project that has never had a session
// still contributes its own last_synced_at.
const ACTIVITY_SQL = `
  WITH latest AS (
    SELECT COALESCE(p.machine, $1) AS machine,
           s.id, s.title, p.name AS project, s.last_synced_at,
           ROW_NUMBER() OVER (
             PARTITION BY COALESCE(p.machine, $1)
             ORDER BY s.last_synced_at DESC NULLS LAST, s.id DESC
           ) AS rn
    FROM sessions s
    JOIN projects p ON p.id = s.project_id
    WHERE s.deleted_at IS NULL
  ),
  totals AS (
    SELECT COALESCE(p.machine, $1) AS machine,
           COUNT(DISTINCT p.id) AS projects,
           COUNT(DISTINCT s.id) AS sessions,
           COALESCE(SUM(s.message_count), 0) AS messages,
           MAX(GREATEST(p.last_synced_at, s.last_synced_at)) AS last_indexed_at
    FROM projects p
    LEFT JOIN sessions s ON s.project_id = p.id AND s.deleted_at IS NULL
    GROUP BY 1
  )
  SELECT t.machine, t.projects, t.sessions, t.messages, t.last_indexed_at,
         l.id AS last_session_id,
         l.title AS last_session_title,
         l.project AS last_session_project,
         l.last_synced_at AS last_session_synced_at
  FROM totals t
  LEFT JOIN latest l ON l.machine = t.machine AND l.rn = 1
  ORDER BY t.last_indexed_at DESC NULLS LAST, t.machine ASC
`

export const getMachineActivity = async (): Promise<MachineActivity[]> => {
  const result = await query<ActivityRow>(ACTIVITY_SQL, [UNKNOWN_MACHINE])

  return result.rows.map(r => ({
    machine: r.machine,
    projects: Number(r.projects),
    sessions: Number(r.sessions),
    messages: Number(r.messages),
    lastIndexedAt: r.last_indexed_at,
    lastSession: r.last_session_id
      ? {
          id: r.last_session_id,
          title: r.last_session_title,
          project: r.last_session_project,
          syncedAt: r.last_session_synced_at,
        }
      : null,
  }))
}

// The machine whose sync landed most recently — the direct answer to "what
// computer was last indexed". Null when nothing has ever been indexed.
export const mostRecentlyIndexed = (activity: MachineActivity[]): string | null =>
  activity.find(a => a.lastIndexedAt !== null)?.machine ?? null

export type MachineSession = {
  id: number
  title: string | null
  project: string | null
  messageCount: number
  startedAt: string | null
  syncedAt: string | null
}

type SessionRow = {
  id: number
  title: string | null
  project: string | null
  message_count: string | null
  started_at: string | null
  last_synced_at: string | null
}

// Titles come back whole — pagination, not truncation, is how callers deal with
// a large result (see the No Truncation Policy in CLAUDE.md).
export const getMachineSessions = async (
  machine: string,
  limit: number,
  offset: number
): Promise<MachineSession[]> => {
  const result = await query<SessionRow>(
    `SELECT s.id, s.title, p.name AS project, s.message_count,
            s.started_at, s.last_synced_at
     FROM sessions s
     JOIN projects p ON p.id = s.project_id
     WHERE COALESCE(p.machine, $1) = $2
       AND s.deleted_at IS NULL
     ORDER BY s.last_synced_at DESC NULLS LAST, s.id DESC
     LIMIT $3 OFFSET $4`,
    [UNKNOWN_MACHINE, machine, limit, offset]
  )

  return result.rows.map(r => ({
    id: r.id,
    title: r.title,
    project: r.project,
    messageCount: Number(r.message_count ?? 0),
    startedAt: r.started_at,
    syncedAt: r.last_synced_at,
  }))
}
