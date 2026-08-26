import assert from 'node:assert'
import { query } from '../db/postgres.js'
import { querySimilar } from '../db/chroma.js'
import { config } from '../config.js'
import { getInteractiveOllamaClient } from '../embeddings/ollama.js'
import { subtractVectors, normalizeVector, addVectors, scaleVector } from '../utils/vector-math.js'
import { projectPathVariants, isWindowsBackedPath } from '../utils/project-path.js'
import { fuseRanks, type RankedList } from './rrf.js'
import { buildSnippet, ts_headline_options } from './snippet.js'
import { resolveTitle, type TitleSource } from './title.js'
import { parseSinceDate } from './since.js'
import { resolveTagFilter, passesTagFilter, getSessionTags, type TagFilter } from './tags.js'

const PROJECT_BOOST = 0.5

const UNLIKE_DAMPENING = 0.2

type WeightedId = { id: string; weight: number }
type ResolvedCentroid = { id: string; weight: number; centroid: number[] }

export type SearchParams = {
  query?: string
  negativeQuery?: string
  excludeTerms?: string
  cwd?: string
  mode?: 'semantic' | 'text' | 'hybrid'
  limit?: number
  source?: string
  since?: string
  projectOnly?: boolean
  likeSession?: string[]
  unlikeSession?: string[]
  likeProject?: string[]
  unlikeProject?: string[]
  includeAutomated?: boolean
  // A session with no summary has no real title and no session-tier vector, so
  // it can only ever arrive as an untriageable row. Withheld by default; pass
  // true to reach one deliberately (issue #95).
  includeUnsummarized?: boolean
  dataClass?: string[]
  // Open-vocabulary agent tags (src/mcp/tags.ts). `tags` narrows to things
  // carrying any of them; `excludeTags` hides things carrying any of them, on
  // top of the configured default-excluded set. Unknown tags are NOT an error
  // here -- an unused tag simply matches nothing, which is the honest answer
  // for a vocabulary anyone may extend at any time.
  tags?: string[]
  excludeTags?: string[]
}

// Which effective data classes this search may see. null means unfiltered.
// - An explicit dataClass wins; '*' anywhere in it disables the filter.
// - An explicit source already names exactly what the caller wants, so it
//   bypasses the fail-closed default (an explicit dataClass still ANDs with it).
// - Otherwise the default: coding data only.
// Values are trimmed and lowercased — the vocabulary is lowercase, and a
// miscased value should match rather than silently return nothing.
export const resolveDataClasses = (
  params: Pick<SearchParams, 'dataClass' | 'source'>
): string[] | null => {
  const cleaned = (params.dataClass ?? [])
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0)
  if (cleaned.length > 0) return cleaned.includes('*') ? null : cleaned
  if (params.source) return null
  return ['coding']
}

// A dataClass value nobody has ever classified anything under would silently
// return zero results; name the valid vocabulary instead.
export class UnknownDataClassError extends Error {
  constructor(unknown: string[], known: string[]) {
    super(
      `Unknown dataClass value(s): ${unknown.join(', ')}. Valid values: ${known.join(', ')}, or "*" for everything.`
    )
    this.name = 'UnknownDataClassError'
  }
}

// Every class in use: source classifications plus project overrides.
// Shared with ingest, which names this vocabulary when a caller must classify.
export const listKnownDataClasses = async (): Promise<string[]> => {
  const result = await query<{ data_class: string }>(
    `SELECT DISTINCT data_class FROM (
       SELECT data_class FROM sources
       UNION
       SELECT data_class FROM projects WHERE data_class IS NOT NULL
     ) classes
     ORDER BY data_class`
  )
  return result.rows.map((r) => r.data_class)
}

const assertKnownDataClasses = async (dataClasses: string[]) => {
  const known = await listKnownDataClasses()
  // An empty vocabulary means the migration hasn't classified anything yet;
  // rejecting the default ["coding"] then would make search unusable.
  if (known.length === 0) return
  const unknown = dataClasses.filter((c) => !known.includes(c))
  if (unknown.length > 0) throw new UnknownDataClassError(unknown, known)
}

export type MatchedTier = 'session' | 'chunk' | 'message'

export type SearchCursor = { chunk_index?: number; message_id?: number }

export type SearchResult = {
  session_id: number
  project_name: string
  project_path: string
  source: string
  data_class: string
  // Null when the session has neither a source-supplied title nor a summary.
  // `title_source` says which one this is, so a consumer can tell a real title
  // from a derived one instead of guessing (issue #95).
  title: string | null
  title_source: TitleSource
  date: Date
  score: number
  matched_tier: MatchedTier
  snippet: string | null
  cursor?: SearchCursor
  // Session-level tags, attached after ranking so a caller can see what a
  // result has been judged as without a second call. Absent when untagged.
  tags?: string[]
}

// A session can be hit by several arms; we keep the first (best-ranked) hit's
// tier + cursor + the raw text its snippet is built from, plus an optional
// ts_headline window when query terms ran in the text arm.
type Hit = {
  result: SearchResult
  projectId: number
  rawSnippet: string | null
  headline: string | null
}

const parseWeightedIds = (params: string[]): WeightedId[] =>
  params
    .map((item) => {
      const trimmed = item.trim()
      const colonIndex = trimmed.lastIndexOf(':')
      if (colonIndex > 0) {
        const weight = Number.parseFloat(trimmed.slice(colonIndex + 1))
        if (!Number.isNaN(weight)) return { id: trimmed.slice(0, colonIndex), weight }
      }
      return { id: trimmed, weight: 1.0 }
    })
    .filter((item) => item.id.length > 0)

// Search is the one Ollama caller with a person waiting on it, so it uses the
// interactive client: one attempt, seconds not minutes, and no waiting out a
// GPU-gate cooldown. When that fails the semantic arms are skipped and the
// caller is told the results are full-text only — see `degraded` below.
const getQueryEmbedding = async (text: string) => {
  const response = await getInteractiveOllamaClient().embed({
    model: config.embeddings.model,
    input: text,
  })
  return response.embeddings[0]
}

const composeQueryVector = async (
  queryText: string | undefined,
  negativeQuery: string | undefined,
  likeSessionCentroids: ResolvedCentroid[] = [],
  unlikeSessionCentroids: ResolvedCentroid[] = [],
  likeProjectCentroids: ResolvedCentroid[] = [],
  unlikeProjectCentroids: ResolvedCentroid[] = []
) => {
  let vec = queryText ? await getQueryEmbedding(queryText) : new Array(1024).fill(0)

  if (negativeQuery) vec = subtractVectors(vec, await getQueryEmbedding(negativeQuery))

  for (const { centroid, weight } of likeSessionCentroids)
    vec = addVectors(vec, scaleVector(centroid, weight))
  for (const { centroid, weight } of unlikeSessionCentroids)
    vec = subtractVectors(vec, scaleVector(centroid, weight * UNLIKE_DAMPENING))
  for (const { centroid, weight } of likeProjectCentroids)
    vec = addVectors(vec, scaleVector(centroid, weight))
  for (const { centroid, weight } of unlikeProjectCentroids)
    vec = subtractVectors(vec, scaleVector(centroid, weight * UNLIKE_DAMPENING))

  return normalizeVector(vec)
}

// Every directory the cwd is inside, itself first: `D:/a/b` -> `D:/a/b`,
// `D:/a`, `D:/`. Enumerating these lets an ancestor project be found by exact
// equality instead of by using the stored path as a LIKE pattern — which both
// removed a wildcard hazard (`_` and `%` are legal in a path) and gave the
// comparison a real separator boundary, so a project at `D:/pro` no longer
// matches a cwd of `D:/projects`.
const ancestorsOf = (path: string): string[] => {
  const out = [path]
  let current = path
  for (;;) {
    if (current === '/' || /^[A-Za-z]:\/$/.test(current)) break
    const cut = current.lastIndexOf('/')
    if (cut < 0) break
    let parent = current.slice(0, cut)
    if (parent === '') parent = '/'
    else if (/^[A-Za-z]:$/.test(parent)) parent = `${parent}/`
    if (parent === current) break
    out.push(parent)
    current = parent
  }
  return [...new Set(out)]
}

// `_` and `%` are ordinary characters in a directory name; escape them so a
// path is matched literally.
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

const descendantPattern = (path: string) => `${escapeLike(path)}${path.endsWith('/') ? '' : '/'}%`

// Matches the caller's cwd against stored (canonical, #33) project paths in
// every spelling of the same directory: `D:\x`, `D:/x` and `/mnt/d/x` all find
// each other, case-insensitively where the filesystem provably is. The caller
// sends whatever its OS gave it — normalization is automatic here, never the
// caller's job.
//
// A project matches when it contains the cwd (any ancestor directory, matched
// exactly) or when it lives under the cwd (one escaped prefix pattern).
export const findProjectsByPath = async (cwd: string) => {
  const variants = projectPathVariants(cwd)
  if (variants.length === 0) return []
  // Case-insensitive matching needs the same evidence as everywhere else: a
  // `D:` path proves the filesystem, a bare `/mnt/<letter>` does not. The
  // drive-form variant of a `/mnt` cwd is generated above, so a Windows row
  // is still found either way.
  const exact: string[] = []
  const exactLower: string[] = []
  const under: string[] = []
  const underLower: string[] = []
  for (const variant of variants) {
    const windowsBacked = isWindowsBackedPath(variant)
    for (const ancestor of ancestorsOf(variant)) {
      if (windowsBacked) exactLower.push(ancestor.toLowerCase())
      else exact.push(ancestor)
    }
    if (windowsBacked) underLower.push(descendantPattern(variant))
    else under.push(descendantPattern(variant))
  }
  const result = await query<{ id: number; path: string; name: string; source_name: string }>(
    `SELECT p.id, p.path, p.name, s.name as source_name
     FROM projects p
     JOIN sources s ON p.source_id = s.id
     WHERE p.path IS NOT NULL
       AND (p.path = ANY($1::text[])
            OR lower(p.path) = ANY($2::text[])
            OR p.path LIKE ANY($3::text[])
            OR p.path ILIKE ANY($4::text[]))
     ORDER BY LENGTH(p.path) DESC`,
    [exact, exactLower, under, underLower]
  )
  return result.rows
}

type SessionRow = {
  id: number
  title: string | null
  summary: string | null
  project_name: string
  project_path: string
  source_name: string
  data_class: string
  started_at: Date
  message_count: number
  project_id: number
}

// Automated sessions are excluded unless explicitly opted in via includeAutomated.
const AUTOMATED_FILTER = `($2::boolean OR s.is_automated = false)`

const SESSION_QUERY = `
  SELECT s.id, s.title, s.summary, p.name as project_name, p.path as project_path,
         src.name as source_name, COALESCE(p.data_class, src.data_class) as data_class,
         s.started_at, s.message_count, p.id as project_id
  FROM sessions s
  JOIN projects p ON s.project_id = p.id
  JOIN sources src ON p.source_id = src.id
  WHERE s.deleted_at IS NULL`

const getSessionById = async (sessionId: number, includeAutomated: boolean) => {
  const result = await query<SessionRow>(
    `${SESSION_QUERY} AND ${AUTOMATED_FILTER} AND s.id = $1`,
    [sessionId, includeAutomated]
  )
  return result.rows[0] ?? null
}

type MessageAnchoredRow = SessionRow & { message_id: number; content_text: string | null }

const getSessionByMessageId = async (messageId: number, includeAutomated: boolean) => {
  const result = await query<MessageAnchoredRow>(
    `SELECT s.id, s.title, s.summary, p.name as project_name, p.path as project_path,
            src.name as source_name, COALESCE(p.data_class, src.data_class) as data_class,
            s.started_at, s.message_count, p.id as project_id,
            m.id as message_id, m.content_text
     FROM messages m
     JOIN sessions s ON m.session_id = s.id
     JOIN projects p ON s.project_id = p.id
     JOIN sources src ON p.source_id = src.id
     WHERE m.id = $1 AND s.deleted_at IS NULL AND ${AUTOMATED_FILTER}`,
    [messageId, includeAutomated]
  )
  return result.rows[0] ?? null
}

type ChunkAnchoredRow = SessionRow & { chunk_index: number; chunk_summary: string }

const getSessionByChunkId = async (chunkId: number, includeAutomated: boolean) => {
  const result = await query<ChunkAnchoredRow>(
    `SELECT s.id, s.title, s.summary, p.name as project_name, p.path as project_path,
            src.name as source_name, COALESCE(p.data_class, src.data_class) as data_class,
            s.started_at, s.message_count, p.id as project_id,
            c.chunk_index, c.summary as chunk_summary
     FROM session_chunks c
     JOIN sessions s ON c.session_id = s.id
     JOIN projects p ON s.project_id = p.id
     JOIN sources src ON p.source_id = src.id
     WHERE c.id = $1 AND s.deleted_at IS NULL AND ${AUTOMATED_FILTER}`,
    [chunkId, includeAutomated]
  )
  return result.rows[0] ?? null
}

const resolveCentroids = async (table: 'sessions' | 'projects', weightedIds: WeightedId[]) => {
  if (weightedIds.length === 0) return []
  const resolved: ResolvedCentroid[] = []

  for (const { id, weight } of weightedIds) {
    const numId = parseInt(id)
    if (isNaN(numId)) continue

    const result = await query<{ centroid_vector: string | null }>(
      `SELECT centroid_vector FROM ${table} WHERE id = $1 AND centroid_vector IS NOT NULL`,
      [numId]
    )

    if (result.rows[0]?.centroid_vector)
      resolved.push({ id, weight, centroid: JSON.parse(result.rows[0].centroid_vector) })
  }
  return resolved
}

// resolveTitle returns camelCase; SearchResult is the SQL-shaped snake_case row
// shared with the MCP tools, so the seam converts once here.
const resolveTitleFields = (row: { title: string | null; summary: string | null }) => {
  const { title, titleSource } = resolveTitle(row)
  return { title, title_source: titleSource }
}

const baseResult = (s: SessionRow, score: number, tier: MatchedTier): SearchResult => ({
  session_id: s.id,
  project_name: s.project_name,
  project_path: s.project_path,
  source: s.source_name,
  data_class: s.data_class,
  ...resolveTitleFields(s),
  date: s.started_at,
  score,
  matched_tier: tier,
  snippet: null,
})

// `messageId` is the message this hit is anchored to, when there is one. It
// only matters to the tag filter, which can hide an individual message without
// hiding its whole session -- see passesTagFilter for why that asymmetry
// exists. Session-anchored arms pass nothing and are judged on session tags
// alone.
const passesFilters = (
  session: SessionRow,
  params: { source?: string; projectOnly?: boolean; includeUnsummarized?: boolean },
  sinceDate: Date | null,
  projectIds: number[],
  dataClasses: string[] | null,
  tagFilter: TagFilter,
  messageId?: number
) => {
  if (!params.includeUnsummarized && session.summary === null) return false
  if (dataClasses && !dataClasses.includes(session.data_class)) return false
  if (params.source && session.source_name !== params.source) return false
  if (sinceDate && session.started_at < sinceDate) return false
  if (params.projectOnly && !projectIds.includes(session.project_id)) return false
  if (!passesTagFilter(tagFilter, session.id, messageId)) return false
  return true
}

// Why a search returned less than it was asked for, or null when it ran whole.
//
// The semantic arms need a query vector, and the only thing that can produce
// one is an Ollama behind a GPU gate that is entitled to say "not now".
// Full-text needs nothing but Postgres, so it still works — and handing those
// results back immediately is better than making someone wait for a vector that
// is not coming. What must not happen is handing them back *silently*: full
// text matches words, not meaning, so a caller who believes it got a semantic
// search will read far too much into a miss.
export type SearchDegradation = {
  // The semantic arms were skipped. In hybrid mode the results are full-text
  // only; in `semantic` mode there are no results at all.
  semantic: false
  reason: string
}

export type SearchOutcome = {
  results: SearchResult[]
  degraded: SearchDegradation | null
}

export const searchWithDiagnostics = async (params: SearchParams): Promise<SearchOutcome> => {
  const limit = params.limit ?? 8
  const mode = params.mode ?? 'hybrid'
  const includeAutomated = params.includeAutomated ?? false

  if (
    !params.query &&
    !params.likeSession &&
    !params.likeProject &&
    !params.unlikeSession &&
    !params.unlikeProject
  )
    throw new Error('Must provide either query or centroid parameters (likeSession, likeProject, etc.)')

  const matchingProjects = params.cwd ? await findProjectsByPath(params.cwd) : []
  const projectIds = matchingProjects.map((p) => p.id)
  const sinceDate = parseSinceDate(params.since)
  const dataClasses = resolveDataClasses(params)
  if (dataClasses) await assertKnownDataClasses(dataClasses)
  // Resolved once and shared by every arm. Note this runs even with no tag
  // params: the configured default-excluded set ("useless") applies to a plain
  // search too, which is the whole point of it being a default.
  const tagFilter = await resolveTagFilter(params)
  // Chroma knows nothing about data classes, so an active class filter can
  // starve the semantic arms (~70% of sessions may be filtered out after the
  // fetch). Over-fetch harder when a filter is on to compensate.
  const overFetch = dataClasses ? 5 : null

  const [likeSessionCentroids, unlikeSessionCentroids, likeProjectCentroids, unlikeProjectCentroids] =
    await Promise.all([
      resolveCentroids('sessions', params.likeSession ? parseWeightedIds(params.likeSession) : []),
      resolveCentroids('sessions', params.unlikeSession ? parseWeightedIds(params.unlikeSession) : []),
      resolveCentroids('projects', params.likeProject ? parseWeightedIds(params.likeProject) : []),
      resolveCentroids('projects', params.unlikeProject ? parseWeightedIds(params.unlikeProject) : []),
    ])

  const hitBySession = new Map<number, Hit>()
  const inProject = new Set<number>()
  const rankedLists: RankedList[] = []
  let degraded: SearchDegradation | null = null

  // First arm to claim a session wins its tier/cursor/snippet source. Arms run
  // session → chunk → message → fts; later, fusion across all arms decides rank.
  const record = (
    result: SearchResult,
    projectId: number,
    rawSnippet: string | null,
    headline: string | null
  ) => {
    if (projectIds.includes(projectId)) inProject.add(result.session_id)
    if (!hitBySession.has(result.session_id))
      hitBySession.set(result.session_id, { result, projectId, rawSnippet, headline })
  }

  if (mode === 'semantic' || mode === 'hybrid') {
    try {
      const embedding = await composeQueryVector(
        params.query,
        params.negativeQuery,
        likeSessionCentroids,
        unlikeSessionCentroids,
        likeProjectCentroids,
        unlikeProjectCentroids
      )

      const sessionHits = await querySimilar(config.chroma.collections.sessions, embedding, limit * (overFetch ?? 2))
      if (sessionHits.ids[0]) {
        const sessionRanked: RankedList = []
        for (let i = 0; i < sessionHits.ids[0].length; i++) {
          const sessionId = parseInt(sessionHits.ids[0][i].replace('session-', ''))
          const score = 1 - (sessionHits.distances?.[0]?.[i] ?? 1)
          const session = await getSessionById(sessionId, includeAutomated)
          if (!session) continue
          if (!passesFilters(session, params, sinceDate, projectIds, dataClasses, tagFilter)) continue
          record(baseResult(session, score, 'session'), session.project_id, session.summary, null)
          sessionRanked.push(session.id)
        }
        rankedLists.push(sessionRanked)
      }

      const chunkHits = await querySimilar(config.chroma.collections.chunks, embedding, limit * (overFetch ?? 3))
      if (chunkHits.ids[0]) {
        const chunkRanked: RankedList = []
        const seen = new Set<number>()
        for (let i = 0; i < chunkHits.ids[0].length; i++) {
          const chunkId = parseInt(chunkHits.ids[0][i].replace('chunk-', ''))
          const score = 1 - (chunkHits.distances?.[0]?.[i] ?? 1)
          const session = await getSessionByChunkId(chunkId, includeAutomated)
          if (!session) continue
          if (!passesFilters(session, params, sinceDate, projectIds, dataClasses, tagFilter)) continue
          if (seen.has(session.id)) continue
          seen.add(session.id)
          const result = baseResult(session, score, 'chunk')
          result.cursor = { chunk_index: session.chunk_index }
          record(result, session.project_id, session.chunk_summary, null)
          chunkRanked.push(session.id)
        }
        rankedLists.push(chunkRanked)
      }

      const messageHits = await querySimilar(config.chroma.collections.messages, embedding, limit * (overFetch ?? 3))
      if (messageHits.ids[0]) {
        // Chroma returns messages in distance order; first appearance of a
        // session is its best-ranked message, so dedup preserves rank order.
        const messageRanked: RankedList = []
        const seen = new Set<number>()
        for (let i = 0; i < messageHits.ids[0].length; i++) {
          const messageId = parseInt(messageHits.ids[0][i].replace('msg-', ''))
          const score = 1 - (messageHits.distances?.[0]?.[i] ?? 1)
          const session = await getSessionByMessageId(messageId, includeAutomated)
          if (!session) continue
          if (!passesFilters(session, params, sinceDate, projectIds, dataClasses, tagFilter, session.message_id))
            continue
          if (seen.has(session.id)) continue
          seen.add(session.id)
          const result = baseResult(session, score, 'message')
          result.cursor = { message_id: session.message_id }
          record(result, session.project_id, session.content_text, null)
          messageRanked.push(session.id)
        }
        rankedLists.push(messageRanked)
      }
    } catch (e) {
      // Reached in seconds now rather than after ~120s of retrying a shut gate:
      // getQueryEmbedding uses the interactive client, which does not wait one
      // out. The reason travels with the results instead of only to the log.
      const reason = e instanceof Error ? e.message : String(e)
      console.error('Semantic search failed, returning full-text results only:', reason)
      degraded = { semantic: false, reason }
    }
  }

  if ((mode === 'text' || mode === 'hybrid') && params.query) {
    const conditions = [
      `to_tsvector('english', m.content_text) @@ websearch_to_tsquery('english', $1)`,
      `s.deleted_at IS NULL`,
      `($2::text IS NULL OR src.name = $2)`,
      `($3::timestamptz IS NULL OR s.started_at >= $3)`,
      `($4::boolean OR s.is_automated = false)`,
    ]
    // Same rule as the semantic arms, applied in SQL: a session with no summary
    // is not surfaced unless the caller asks for one.
    if (!params.includeUnsummarized) conditions.push(`s.summary IS NOT NULL`)
    const values: unknown[] = [params.query, params.source ?? null, sinceDate, includeAutomated]
    let nextParam = 5

    if (params.projectOnly && projectIds.length > 0) {
      conditions.push(`s.project_id = ANY($${nextParam++}::int[])`)
      values.push(projectIds)
    }

    if (dataClasses) {
      conditions.push(`COALESCE(p.data_class, src.data_class) = ANY($${nextParam++}::text[])`)
      values.push(dataClasses)
    }

    if (params.excludeTerms) {
      conditions.push(
        `NOT to_tsvector('english', m.content_text) @@ websearch_to_tsquery('english', $${nextParam++})`
      )
      values.push(params.excludeTerms)
    }

    // The SAME resolved filter the semantic arms use, pushed into SQL rather
    // than applied to the rows afterwards. Filtering here matters because this
    // arm has a LIMIT: dropping tagged rows in JS would let excluded sessions
    // consume the result budget and silently shrink the answer.
    if (tagFilter.includedSessions) {
      conditions.push(`s.id = ANY($${nextParam++}::int[])`)
      values.push([...tagFilter.includedSessions])
    }
    if (tagFilter.excludedSessions.size > 0) {
      conditions.push(`s.id <> ALL($${nextParam++}::int[])`)
      values.push([...tagFilter.excludedSessions])
    }
    if (tagFilter.excludedMessages.size > 0) {
      conditions.push(`m.id <> ALL($${nextParam++}::bigint[])`)
      values.push([...tagFilter.excludedMessages])
    }

    values.push(limit * 2)
    const limitParam = `$${nextParam}`

    const ftsResult = await query<{
      session_id: number
      message_id: number
      title: string | null
      summary: string | null
      project_name: string
      project_path: string
      source_name: string
      data_class: string
      started_at: Date
      message_count: number
      rank: number
      project_id: number
      headline: string
    }>(
      `WITH ranked_messages AS (
        SELECT DISTINCT ON (m.session_id)
          m.session_id,
          m.id as message_id,
          m.content_text,
          ts_rank(to_tsvector('english', m.content_text), websearch_to_tsquery('english', $1)) as rank
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        JOIN projects p ON s.project_id = p.id
        JOIN sources src ON p.source_id = src.id
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY m.session_id, rank DESC
      )
      SELECT rm.session_id, rm.message_id, s.title, s.summary, p.name as project_name, p.path as project_path,
             src.name as source_name, COALESCE(p.data_class, src.data_class) as data_class,
             s.started_at, s.message_count, rm.rank,
             p.id as project_id,
             ts_headline('english', rm.content_text, websearch_to_tsquery('english', $1), '${ts_headline_options}') as headline
      FROM ranked_messages rm
      JOIN sessions s ON rm.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      JOIN sources src ON p.source_id = src.id
      ORDER BY rm.rank DESC
      LIMIT ${limitParam}`,
      values
    )

    // Rows already ordered by rank DESC — their order is the FTS ranking.
    const ftsRanked: RankedList = []
    for (const row of ftsResult.rows) {
      const result: SearchResult = {
        session_id: row.session_id,
        project_name: row.project_name,
        project_path: row.project_path,
        source: row.source_name,
        data_class: row.data_class,
        ...resolveTitleFields(row),
        date: row.started_at,
        score: row.rank,
        matched_tier: 'message',
        snippet: null,
        cursor: { message_id: row.message_id },
      }
      // FTS arm has a real ts_headline window; if this session was already
      // claimed by a semantic arm, upgrade its snippet to the highlighted one.
      const existing = hitBySession.get(row.session_id)
      if (existing) existing.headline = row.headline
      record(result, row.project_id, null, row.headline)
      ftsRanked.push(row.session_id)
    }
    rankedLists.push(ftsRanked)
  }

  const fused = fuseRanks(rankedLists)

  const results = Array.from(hitBySession.values()).map((hit) => {
    const score = (fused.get(hit.result.session_id) ?? 0) + (inProject.has(hit.result.session_id) ? PROJECT_BOOST : 0)
    return { ...hit.result, score, snippet: buildSnippet(hit.rawSnippet, hit.headline) }
  })
  results.sort((a, b) => b.score - a.score)

  // Decorate only the page actually returned, so a wide candidate set costs
  // one small query rather than one per discarded hit.
  const page = results.slice(0, limit)
  const tagsBySession = await getSessionTags(page.map((r) => r.session_id))
  for (const result of page) {
    const tags = tagsBySession.get(result.session_id)
    if (tags && tags.length > 0) result.tags = tags
  }

  return { results: page, degraded }
}

// The plain form, for callers that have nothing useful to do with the
// diagnostics. Everything user-facing should prefer searchWithDiagnostics and
// say when the answer was only half-computed.
export const search = async (params: SearchParams): Promise<SearchResult[]> =>
  (await searchWithDiagnostics(params)).results

// An LLM reading this cannot see the log line, and "no results" reads as "this
// conversation does not exist" — a conclusion it will then act on. So a
// degraded search says so in the text, including when it found nothing.
const degradedNote = (degraded: SearchDegradation | null) =>
  degraded
    ? `\n\nNOTE: full-text results only — semantic search was unavailable (${degraded.reason}). Meaning-based matches are missing, so absence here is not evidence a conversation does not exist. Retry shortly for a full search.`
    : ''

export const formatSearchResults = (
  results: SearchResult[],
  projectIds: number[] = [],
  degraded: SearchDegradation | null = null
) => {
  if (results.length === 0) return `No matching conversations found.${degradedNote(degraded)}`

  const output = results
    .map((r, i) => {
      const projectLabel = projectIds.includes(r.session_id) ? ' [CURRENT PROJECT]' : ''
      assert(r.date, `Missing date for session ${r.session_id}`)
      const cursor = r.cursor?.chunk_index != null
        ? `\n   Cursor: chunk ${r.cursor.chunk_index}`
        : r.cursor?.message_id != null
          ? `\n   Cursor: message ${r.cursor.message_id}`
          : ''
      // No title is an honest answer: the session has no source-supplied title
      // and has not been summarized yet. Naming the session and saying so beats
      // handing a triaging LLM an instruction fragment as if it were a topic.
      const heading = r.title ?? `Session ${r.session_id} (no title — not summarized yet)`
      // Shown only when there are any, so an untagged corpus reads exactly as
      // it did before tags existed.
      const tags = r.tags?.length ? `\n   Tags: ${r.tags.join(', ')}` : ''
      return `${i + 1}. **${heading}**${projectLabel}
   Session ID: ${r.session_id}
   Project: ${r.project_name} (${r.source}, ${r.data_class})
   Date: ${r.date.toISOString().split('T')[0]}
   Score: ${r.score.toFixed(3)} | Matched: ${r.matched_tier}${cursor}${tags}
   ${r.snippet ?? '(no snippet)'}`
    })
    .join('\n\n')

  return `Found ${results.length} relevant conversations:\n\n${output}${degradedNote(degraded)}`
}
