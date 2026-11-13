// The search event log (init-db/026-search-log.sql). One row per search and per
// call that follows one, linked by caller key and list handle.
//
// Logging must never slow or break a search, so `record` only enqueues: one
// background loop inserts rows in order, a full queue drops new rows, and a
// failed insert is counted. Counts are visible in /status and the stats tool;
// a queue that silently lost rows would make every number built on it lie.

import { createHash, randomInt } from 'node:crypto'
import { query } from '../db/postgres.js'
import { config } from '../config.js'
import type { SearchDegradation, SearchResult } from './search.js'

export type Transport = 'mcp-http' | 'mcp-stdio' | 'rest'
export type Caller = { key: string; transport: Transport; client: string }

export type ListHandle = string & { readonly __brand: 'ListHandle' }

// No 0/o, 1/l/i: a handle is read off a screen and typed back by models and people.
const HANDLE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
const HANDLE_SHAPE = /^L[2-9a-hjkmnp-z]{6}$/

export const mintListHandle = (): ListHandle => {
  let tail = ''
  for (let i = 0; i < 6; i++) tail += HANDLE_ALPHABET[randomInt(HANDLE_ALPHABET.length)]
  return `L${tail}` as ListHandle
}

export const parseListHandle = (raw: unknown): ListHandle | null =>
  typeof raw === 'string' && HANDLE_SHAPE.test(raw) ? (raw as ListHandle) : null

// Each follow-up tool and the signal its call carries. kind is derived: an open
// reads, everything else is a judgement written as a tag.
const FOLLOW_UP_SIGNAL = {
  getSession: 'open',
  getSessionTranscript: 'open',
  getMessages: 'open',
  getMessage: 'open',
  getChunk: 'open',
  'rest:session': 'open',
  'rest:messages': 'open',
  'rest:message': 'open',
  addTag: 'tag',
  removeTag: 'untag',
  reportUselessSession: 'useless',
  unreportUselessSession: 'unuseless',
} as const

export type FollowUpTool = keyof typeof FOLLOW_UP_SIGNAL
export type FollowUpTarget = { sessionId?: number; messageId?: number; chunkIndex?: number }

export type SearchEvent = {
  kind: 'search'
  at: Date
  caller: Caller
  tool: 'search' | 'rest:search'
  list: ListHandle
  request: Record<string, unknown>
  mode: string
  totalMs: number
} & ({ results: SearchResult[]; degraded: SearchDegradation | null } | { error: string })

export type FollowUpEvent = {
  kind: 'follow-up'
  at: Date
  caller: Caller
  tool: FollowUpTool
  request: Record<string, unknown>
  target: FollowUpTarget
  list: ListHandle | null
}

export type LogEvent = SearchEvent | FollowUpEvent

export type LoggedHit = {
  s: number
  rank: number
  score: number
  tier: SearchResult['matched_tier']
  damping: number | null
  cursor?: SearchResult['cursor']
}

export const toLoggedHits = (results: SearchResult[]): LoggedHit[] =>
  results.map((r, i) => ({
    s: r.session_id,
    rank: i + 1,
    score: r.score,
    tier: r.matched_tier,
    damping: r.noise_damping ?? null,
    ...(r.cursor ? { cursor: r.cursor } : {}),
  }))

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)))
      : v
  )

export const requestHash = (request: Record<string, unknown>): string =>
  createHash('sha256').update(stableJson(request)).digest('hex')

// An open is attributed to a search when it names the list, or else to that
// caller's latest search within this window whose results hold the session.
export const LINK_WINDOW_MINUTES = 30

const INSERT_SEARCH = `
INSERT INTO search_log (at, caller, transport, client, kind, tool, list, request, request_hash,
                        mode, results, result_count, degraded, error, timings)
VALUES ($1, $2, $3, $4, 'search', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`

const INSERT_FOLLOW_UP = `
WITH tgt AS (
  SELECT COALESCE($11::int, (SELECT m.session_id FROM messages m WHERE m.id = $12::bigint)) AS sid
), linked AS (
  SELECT l.list,
         (SELECT (e->>'rank')::int FROM jsonb_array_elements(l.results) e
           WHERE (e->>'s')::int = tgt.sid LIMIT 1) AS rank
  FROM search_log l, tgt
  WHERE l.kind = 'search' AND l.results IS NOT NULL
    AND CASE WHEN $7::text IS NOT NULL THEN l.list = $7::text
             ELSE l.caller = $2 AND l.at > $1::timestamptz - make_interval(mins => ${LINK_WINDOW_MINUTES})
                  AND l.at <= $1::timestamptz
                  AND tgt.sid IS NOT NULL
                  AND l.results @> jsonb_build_array(jsonb_build_object('s', tgt.sid)) END
  ORDER BY (l.caller = $2) DESC, l.at DESC
  LIMIT 1
)
INSERT INTO search_log (at, caller, transport, client, kind, tool, list, request, request_hash,
                        session_id, target, rank, signal)
SELECT $1, $2, $3, $4, $5, $6, COALESCE((SELECT list FROM linked), $7::text), $8, $9,
       tgt.sid, $10, (SELECT rank FROM linked), $13
FROM tgt`

const insertEvent = async (event: LogEvent): Promise<void> => {
  const { at, caller } = event
  if (event.kind === 'search') {
    const ok = 'results' in event
    await query(INSERT_SEARCH, [
      at, caller.key, caller.transport, caller.client, event.tool, event.list,
      event.request, requestHash(event.request), event.mode,
      ok ? JSON.stringify(toLoggedHits(event.results)) : null,
      ok ? event.results.length : null,
      ok ? (event.degraded?.cause ?? null) : null,
      ok ? null : event.error,
      { totalMs: event.totalMs },
    ])
    return
  }
  const signal = FOLLOW_UP_SIGNAL[event.tool]
  await query(INSERT_FOLLOW_UP, [
    at, caller.key, caller.transport, caller.client, signal === 'open' ? 'open' : 'tag', event.tool,
    event.list, event.request, requestHash(event.request), event.target,
    event.target.sessionId ?? null, event.target.messageId ?? null, signal,
  ])
}

export type SearchLogStats = {
  enabled: boolean
  written: number
  failed: number
  dropped: number
  queued: number
  lastFailureAt: string | null
  // A Postgres SQLSTATE only. Driver messages and details can quote the row,
  // and the row holds query text; this object is served on public routes.
  lastFailureCode: string | null
}

export const createSearchLog = ({
  insert,
  capacity,
  enabled,
}: {
  insert: (event: LogEvent) => Promise<void>
  capacity: number
  enabled: boolean
}) => {
  const queue: LogEvent[] = []
  const counts = { written: 0, failed: 0, dropped: 0 }
  let lastFailureAt: Date | null = null
  let lastFailureCode: string | null = null
  let draining: Promise<void> | null = null

  const drainLoop = async () => {
    for (let event = queue.shift(); event; event = queue.shift()) {
      try {
        await insert(event)
        counts.written++
      } catch (error) {
        counts.failed++
        lastFailureAt = new Date()
        lastFailureCode = (error as { code?: string }).code ?? 'unknown'
        if (counts.failed === 1 || counts.failed % 100 === 0)
          console.error(`[search-log] write failed (code ${lastFailureCode}); ${counts.failed} failed so far`)
      }
    }
  }

  const kick = (): void => {
    if (draining) return
    draining = Promise.resolve()
      .then(drainLoop)
      .finally(() => {
        draining = null
        if (queue.length > 0) kick()
      })
  }

  const record = (event: LogEvent): void => {
    if (!enabled) return
    if (queue.length >= capacity) {
      counts.dropped++
      return
    }
    queue.push(event)
    kick()
  }

  const stats = (): SearchLogStats => ({
    enabled,
    ...counts,
    queued: queue.length,
    lastFailureAt: lastFailureAt?.toISOString() ?? null,
    lastFailureCode,
  })

  const flushed = async (): Promise<void> => {
    while (draining) await draining
  }

  return { record, stats, flushed }
}

export const searchLog = createSearchLog({
  insert: insertEvent,
  capacity: config.searchLog.queueCapacity,
  enabled: config.searchLog.enabled,
})

// Retention for the one personal field. The row, its hash, results, timings and
// links stay, so stats over old periods still add up.
export const expireRawRequests = async (days = config.searchLog.rawDays): Promise<number> => {
  const result = await query(
    `UPDATE search_log SET request = NULL
     WHERE request IS NOT NULL AND at < now() - make_interval(days => $1)`,
    [days]
  )
  return result.rowCount ?? 0
}

const STDIO_KEY = `stdio:${process.pid}.${Date.now().toString(36)}`
const CALLER_TOKEN = /^[\w.:-]{1,64}$/

const clientName = (info: { name?: string; version?: string } | undefined): string =>
  info?.name ? `${info.name}/${info.version ?? '?'}` : 'unknown'

// HTTP MCP gives every connected client its own transport session id, which is
// exactly the unit a follow-up belongs to. stdio has one client per process.
export const mcpCaller = (
  transport: 'mcp-http' | 'mcp-stdio',
  sessionId: string | undefined,
  clientInfo: { name?: string; version?: string } | undefined
): Caller => ({
  key: transport === 'mcp-http' && sessionId ? `mcp:${sessionId}` : STDIO_KEY,
  transport,
  client: clientName(clientInfo),
})

// REST has no session. A client that wants its opens linked names itself
// (the web UI sends a per-tab id); everyone else shares "rest:anon" and is
// linked by list handle when it passes one.
export const restCaller = (header: (name: string) => string | undefined): Caller => {
  const caller = header('x-mindmeld-caller')
  const client = header('x-mindmeld-client')
  return {
    key: `rest:${caller && CALLER_TOKEN.test(caller) ? caller : 'anon'}`,
    transport: 'rest',
    client: client && CALLER_TOKEN.test(client) ? client : 'rest',
  }
}
