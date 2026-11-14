import ms from 'ms'
import * as chrono from 'chrono-node'
import { query } from '../db/postgres.js'
import { parseSinceDate } from '../mcp/since.js'
import { USELESS_TAG } from '../mcp/noise.js'
import { classifyAutomated } from '../embeddings/classify.js'
import type { QueryReplay, SummaryKind } from './types.js'

// Sessions under ~8,000 characters are never summarized: their "summary" is
// the transcript itself, prefixed with a role tag.
const RAW_SUMMARY = /^\[[A-Z_]+\]: /
const summaryKindOf = (summary: string | null): SummaryKind | null =>
  summary === null ? null : RAW_SUMMARY.test(summary) ? 'raw' : 'generated'

const DATA_CLASS_SQL = 'COALESCE(p.data_class, src.data_class)'

// Sessions a default search should be able to return, stratified by project:
// each project's sessions in a seeded order, then round-robin across projects,
// so one giant project cannot fill a stratum.
export const candidateSessions = async (
  dataClasses: string[],
  seed: string,
  snapshot: number,
  limit: number
): Promise<number[]> => {
  const ids = (
    await query<{ id: number }>(
      `WITH c AS (
         SELECT s.id, s.project_id,
                row_number() OVER (PARTITION BY s.project_id ORDER BY md5(s.id::text || $2)) AS rn
         FROM sessions s JOIN projects p ON p.id = s.project_id JOIN sources src ON src.id = p.source_id
         WHERE s.deleted_at IS NULL AND s.superseded_at IS NULL AND s.summary IS NOT NULL
           AND NOT s.is_automated AND s.content_chars >= 3000 AND s.id <= $3
           AND ${DATA_CLASS_SQL} = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.session_id = s.id AND t.tag = $5)
       )
       SELECT id FROM c ORDER BY rn, md5(project_id::text || $2) LIMIT $4`,
      [dataClasses, seed, snapshot, limit, USELESS_TAG]
    )
  ).rows.map((r) => r.id)
  const automated = await automatedLike(ids)
  return ids.filter((id) => !automated.has(id))
}

// Sessions that open like an automated run by the deployment's configured
// prefixes, whatever their stored flag says: the flag was only set at first
// ingest, so a prefix added later left such sessions searchable (issue #177).
// The same reading the re-classification uses: transcripts by the first line of
// their first user message, everything else by title.
export const automatedLike = async (ids: number[]): Promise<Set<number>> => {
  if (ids.length === 0) return new Set()
  const rows = await query<{ id: number; is_automated: boolean; opening: string | null }>(
    `SELECT s.id, s.is_automated,
            CASE WHEN src.name = ANY($2::text[]) THEN
              (SELECT m.content_text FROM messages m WHERE m.session_id = s.id AND m.role = 'user'
                 AND m.content_text IS NOT NULL ORDER BY m.sequence_num NULLS FIRST, m.timestamp, m.id LIMIT 1)
            ELSE s.title END AS opening
     FROM sessions s JOIN projects p ON p.id = s.project_id JOIN sources src ON src.id = p.source_id
     WHERE s.id = ANY($1::int[])`,
    [ids, ['claude_code', 'codex']]
  )
  return new Set(rows.rows.filter((r) => r.is_automated || classifyAutomated(r.opening)).map((r) => r.id))
}

export type SessionCard = {
  sessionId: number
  title: string | null
  summary: string | null
  summaryKind: SummaryKind | null
  dataClass: string
  projectPath: string | null
  startedAt: string | null
  chunkSummaries: string[]
  messages: { role: string; text: string }[]
}

// What a query writer or judge is shown. Excerpts are cut for the prompt only
// (a model input limit, not an API response). Messages are spread evenly
// across the session because summaries are often the raw first lines.
export const sessionCard = async (
  sessionId: number,
  { messages = 6, chars = 600, chunks = 3 }: { messages?: number; chars?: number; chunks?: number } = {}
): Promise<SessionCard | null> => {
  const head = await query<{
    title: string | null
    summary: string | null
    data_class: string
    path: string | null
    started_at: Date | null
  }>(
    `SELECT s.title, s.summary, ${DATA_CLASS_SQL} AS data_class, p.path, s.started_at
     FROM sessions s JOIN projects p ON p.id = s.project_id JOIN sources src ON src.id = p.source_id
     WHERE s.id = $1`,
    [sessionId]
  )
  const row = head.rows[0]
  if (!row) return null
  const chunkRows = await query<{ summary: string }>(
    `SELECT summary FROM session_chunks WHERE session_id = $1 AND summary IS NOT NULL ORDER BY chunk_index LIMIT $2`,
    [sessionId, chunks]
  )
  const messageRows = await query<{ role: string; text: string }>(
    `WITH m AS (
       SELECT role, left(content_text, $3) AS text,
              row_number() OVER (ORDER BY sequence_num, id) AS rn, count(*) OVER () AS n
       FROM messages
       WHERE session_id = $1 AND role IN ('user', 'assistant', 'memory') AND length(content_text) > 40
     )
     SELECT role, text FROM m WHERE (rn - 1) % greatest(1, n / $2) = 0 ORDER BY rn LIMIT $2`,
    [sessionId, messages, chars]
  )
  return {
    sessionId,
    title: row.title,
    summary: row.summary,
    summaryKind: summaryKindOf(row.summary),
    dataClass: row.data_class,
    projectPath: row.path,
    startedAt: row.started_at?.toISOString() ?? null,
    chunkSummaries: chunkRows.rows.map((r) => r.summary),
    messages: messageRows.rows,
  }
}

export const appearsVerbatim = async (sessionId: number, text: string): Promise<boolean> =>
  (
    await query<{ hit: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM messages WHERE session_id = $1 AND strpos(content_text, $2) > 0) AS hit`,
      [sessionId, text]
    )
  ).rows[0].hit

export const startedAtOf = async (ids: number[]): Promise<Map<number, string | null>> => {
  if (ids.length === 0) return new Map()
  const rows = await query<{ id: number; started_at: Date | null }>(
    `SELECT id, started_at FROM sessions WHERE id = ANY($1::int[])`,
    [ids]
  )
  return new Map(rows.rows.map((r) => [r.id, r.started_at?.toISOString() ?? null]))
}

export const sessionIdsMatchingPaths = async (patterns: string[]): Promise<number[]> =>
  patterns.length === 0
    ? []
    : (
        await query<{ id: number }>(`SELECT id FROM sessions WHERE raw_file_path LIKE ANY($1::text[])`, [patterns])
      ).rows.map((r) => r.id)

export const corpusStats = async (): Promise<Record<string, number>> => {
  const row = (
    await query<Record<string, string>>(
      `SELECT max(s.id) AS max_session_id, count(*) AS sessions,
              count(*) FILTER (WHERE s.deleted_at IS NULL AND NOT s.is_automated AND s.summary IS NOT NULL) AS searchable,
              count(*) FILTER (WHERE s.summary ~ '^\\[[A-Z_]+\\]: ') AS raw_summaries,
              count(*) FILTER (WHERE s.is_automated) AS automated,
              (SELECT count(*) FROM messages) AS messages,
              (SELECT count(*) FROM session_chunks) AS chunks
       FROM sessions s`
    )
  ).rows[0]
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]))
}

// A relative "since" ("7d", "last week") meant relative to when the agent
// searched; replaying it relative to today would search a different window.
const resolveSinceAt = (since: string, at: Date): string => {
  const trimmed = since.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return parseSinceDate(trimmed)!.toISOString()
  const relative = ms(trimmed as Parameters<typeof ms>[0])
  if (relative) return new Date(at.getTime() - relative).toISOString()
  if (/^[+-]?P/.test(trimmed)) return new Date(at.getTime() - (Date.now() - parseSinceDate(trimmed)!.getTime())).toISOString()
  const parsed = chrono.parseDate(trimmed, at)
  if (!parsed) throw new Error(`unparseable since: ${since}`)
  return parsed.toISOString()
}

export type RealSearch = {
  toolUseId: string
  transcriptSessionId: number
  at: Date
  text: string
  dataClass: string[]
  replay: QueryReplay
  originalMode: string
  listed: number[]
  opened: number[]
}

const REPLAYABLE = new Set(['query', 'limit', 'dataClass', 'mode', 'since', 'cwd', 'includeUnsummarized', 'projectOnly'])

// Agent searches recovered from indexed transcripts: the tool call, the result
// list it got back (parsed from "Session ID: n" lines), and the listed
// sessions it opened within ten minutes and before its next search, which are
// its weak gold. An open is credited to the last search only: crediting every
// search in a burst would count one click several times.
export const realSearches = async (): Promise<RealSearch[]> => {
  const rows = await query<{
    tool_use_id: string
    session_id: number
    at: Date
    input: Record<string, unknown>
    result_text: string | null
    opened: string[] | null
  }>(
    `WITH calls AS (
       SELECT m.session_id, m.timestamp AS at, m.tool_input AS input,
              m.content_json->'content'->0->>'id' AS tool_use_id,
              lead(m.timestamp) OVER (PARTITION BY m.session_id ORDER BY m.timestamp) AS next_at
       FROM messages m
       WHERE m.tool_name ~ 'mindmeld__search$' AND m.tool_input ? 'query'
     )
     SELECT c.tool_use_id, c.session_id, c.at, c.input,
            (SELECT coalesce(r.content_text, r.tool_result) FROM messages r
              WHERE r.session_id = c.session_id AND r.role = 'user'
                AND r.content_json->'content'->0->>'tool_use_id' = c.tool_use_id LIMIT 1) AS result_text,
            (SELECT array_agg(o.tool_input->>'sessionId' ORDER BY o.timestamp) FROM messages o
              WHERE o.session_id = c.session_id
                AND o.tool_name ~ 'mindmeld__(getSession|getMessages|getChunk|getSessionTranscript)$'
                AND o.timestamp > c.at AND o.timestamp <= c.at + interval '10 minutes'
                AND (c.next_at IS NULL OR o.timestamp < c.next_at)
                AND o.tool_input ? 'sessionId') AS opened
     FROM calls c
     WHERE c.tool_use_id IS NOT NULL
     ORDER BY c.at`
  )
  const seen = new Set<string>()
  const out: RealSearch[] = []
  for (const row of rows.rows) {
    const text = String(row.input.query ?? '').trim()
    if (!text || seen.has(text.toLowerCase())) continue
    if (Object.keys(row.input).some((k) => !REPLAYABLE.has(k))) continue
    const listed = [...(row.result_text ?? '').matchAll(/Session ID: (\d+)/g)].map((m) => Number(m[1]))
    const opened = [...new Set((row.opened ?? []).map(Number))].filter((id) => listed.includes(id))
    if (opened.length === 0) continue
    seen.add(text.toLowerCase())
    const rawClass = row.input.dataClass
    const dataClass = Array.isArray(rawClass) ? rawClass.map(String) : typeof rawClass === 'string' ? [rawClass] : []
    let since: string | undefined
    try {
      since = typeof row.input.since === 'string' ? resolveSinceAt(row.input.since, row.at) : undefined
    } catch {
      continue
    }
    out.push({
      toolUseId: row.tool_use_id,
      transcriptSessionId: row.session_id,
      at: row.at,
      text,
      originalMode: typeof row.input.mode === 'string' ? row.input.mode : 'default',
      dataClass,
      replay: {
        cwd: typeof row.input.cwd === 'string' ? row.input.cwd : undefined,
        since,
        projectOnly: row.input.projectOnly === true ? true : undefined,
      },
      listed,
      opened,
    })
  }
  return out
}
