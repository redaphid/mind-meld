// Reads the shared `logs` table that every mindmeld process writes to. This is
// what lets /logs show all machines at once — the in-process ring buffer only
// ever sees the container it lives in.

import { query } from '../db/postgres.js'

export type StoredLog = {
  id: string
  machine: string
  service: string
  level: string
  message: string
  loggedAt: string
}

export type StoredLogQuery = {
  limit: number
  offset: number
  machine?: string
  service?: string
  level?: string
  contains?: string
}

type StoredLogRow = {
  id: string
  machine: string
  service: string
  level: string
  message: string
  logged_at: string
}

// Builds the shared WHERE clause so the page query and the count query can
// never drift apart and report inconsistent totals.
const buildFilter = (q: StoredLogQuery) => {
  const clauses: string[] = []
  const params: unknown[] = []

  const add = (sql: string, value: unknown) => {
    params.push(value)
    clauses.push(sql.replace('?', `$${params.length}`))
  }

  if (q.machine) add('machine = ?', q.machine)
  if (q.service) add('service = ?', q.service)
  if (q.level) add('level = ?', q.level)
  // Substring search over the message; callers use it to find a specific run.
  if (q.contains) add('message ILIKE ?', `%${q.contains}%`)

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  }
}

// Newest first. Messages are returned whole — pagination, never truncation.
export const readStoredLogs = async (q: StoredLogQuery): Promise<StoredLog[]> => {
  const { where, params } = buildFilter(q)

  const result = await query<StoredLogRow>(
    `SELECT id, machine, service, level, message, logged_at
     FROM logs
     ${where}
     ORDER BY logged_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, q.limit, q.offset]
  )

  return result.rows.map(r => ({
    id: String(r.id),
    machine: r.machine,
    service: r.service,
    level: r.level,
    message: r.message,
    loggedAt: r.logged_at,
  }))
}

export const countStoredLogs = async (q: StoredLogQuery): Promise<number> => {
  const { where, params } = buildFilter(q)
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM logs ${where}`,
    params
  )
  return Number(result.rows[0]?.count ?? 0)
}

export type LogWriter = {
  machine: string
  service: string
  entries: number
  lastLoggedAt: string | null
}

// Who is actually shipping logs, so a machine that has gone quiet is visible
// as a stale lastLoggedAt rather than by silently missing from the feed.
export const getLogWriters = async (): Promise<LogWriter[]> => {
  const result = await query<{
    machine: string
    service: string
    entries: string
    last_logged_at: string | null
  }>(
    `SELECT machine, service, COUNT(*) AS entries, MAX(logged_at) AS last_logged_at
     FROM logs
     GROUP BY machine, service
     ORDER BY last_logged_at DESC NULLS LAST`
  )

  return result.rows.map(r => ({
    machine: r.machine,
    service: r.service,
    entries: Number(r.entries),
    lastLoggedAt: r.last_logged_at,
  }))
}
