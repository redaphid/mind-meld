import assert from 'node:assert'
import type pg from 'pg'
import { query } from '../db/postgres.js'
import { querySimilar } from '../db/chroma.js'
import { sessionIdFromVectorId } from '../db/vector-ids.js'
import { config } from '../config.js'
import { getInteractiveOllamaClient } from '../embeddings/ollama.js'
import { semanticEnabled } from '../sync/sync-control.js'
import { subtractVectors, normalizeVector, addVectors, scaleVector } from '../utils/vector-math.js'
import { projectPathVariants, isWindowsBackedPath } from '../utils/project-path.js'
import { fuseRanks } from './rrf.js'
import { buildSnippet, ts_headline_options } from './snippet.js'
import { resolveTitle, type TitleSource } from './title.js'
import { parseSinceDate } from './since.js'
import { resolveTagFilter, passesTagFilter, getSessionTags, type TagFilter } from './tags.js'
import { getNoiseModel, dampingAt, nearestSimilarity, sessionVectors, NO_NOISE, USELESS_TAG, type NoiseModel } from './noise.js'
import { LAST_ACTIVITY_SQL, lastActivity } from './last-activity.js'
import {
  byStrength,
  formatBreakdown,
  formatEvidence,
  scoreOf,
  type Adjustment,
  type Arm,
  type Evidence,
  type EvidenceList,
  type Scored,
} from './evidence.js'
import { DEFAULT_SEARCH_MODE, type SearchMode } from './search-mode.js'

const PROJECT_BOOST = 0.5

const UNLIKE_DAMPENING = 0.2

type WeightedId = { id: string; weight: number }
type ResolvedCentroid = { id: string; weight: number; centroid: number[] }

export type SearchParams = {
  query?: string
  negativeQuery?: string
  excludeTerms?: string
  cwd?: string
  mode?: SearchMode
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
  // Noise reported via reportUselessSession. False (the default) means two
  // things at once, and they are two because hiding and ranking are two
  // different mechanisms:
  //   - sessions tagged "useless" are hidden outright, and
  //   - sessions that merely RESEMBLE reported noise are ranked down.
  // true disables both, which is what makes the hidden material reachable
  // again for debugging rather than gone.
  includeNoise?: boolean
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

// The projects whose effective class is one of these. The full-text arm
// filters on the ids rather than on the class expression itself: Postgres has
// no statistics for COALESCE(p.data_class, src.data_class), guessed ~5 matching
// projects when ~900 match, and chose a per-session nested loop that re-ran
// to_tsvector over ~920k messages without touching the GIN index -- 60-120s a
// search, the broadest ones hitting the statement timeout. With the ids it has
// real statistics and matches through the index: measured against the old
// predicate, "database migration" went 71.5s -> 2.4s and "error" 107s -> 44s.
const projectIdsInDataClasses = async (dataClasses: string[]): Promise<number[]> =>
  (
    await query<{ id: number }>(
      `SELECT p.id FROM projects p JOIN sources src ON src.id = p.source_id
       WHERE COALESCE(p.data_class, src.data_class) = ANY($1::text[])`,
      [dataClasses]
    )
  ).rows.map((r) => r.id)

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

// A result is its Scored breakdown plus what it is displayed with. Every field
// after `snippet` up to `tags` is read off the breakdown, never set beside it.
export type SearchResult = Omit<Scored, 'sessionId'> & {
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
  matched_tier: MatchedTier
  snippet: string | null
  cursor?: SearchCursor
  // Session-level tags, attached after ranking so a caller can see what a
  // result has been judged as without a second call. Absent when untagged.
  tags?: string[]
  // The factor the noise penalty multiplied this result's score by: 1 is
  // untouched. Null when the result could not be scored at all -- the penalty
  // was off (includeNoise, includeAutomated, or tags:["useless"]), nothing
  // counts as noise, or the session has no summary vector yet -- which is a
  // different answer from "scored and found clean".
  noise_damping: number | null
}

// The session columns a result is displayed from. Every arm's row carries
// them, and they are the same whichever arm a session came from.
type SessionFields = {
  id: number
  title: string | null
  summary: string | null
  project_name: string
  project_path: string
  source_name: string
  data_class: string
  started_at: Date
  ended_at: Date | null
  project_id: number
}

// One session as one arm found it, in that arm's rank order. `text` is what a
// snippet is cut from when this hit is the credited one; `headline` is the
// full-text arm's query-highlighted window.
type ArmHit = { session: SessionFields; evidence: Evidence; text: string | null; headline: string | null }

type ArmRun = { arm: Arm; hits: ArmHit[] }

// Everything the arms found about one session, before scoring.
type Candidate = {
  session: SessionFields
  evidence: EvidenceList
  texts: Partial<Record<Arm, string | null>>
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
const getQueryEmbedding = async (text: string, signal: AbortSignal) => {
  const response = await getInteractiveOllamaClient(signal).embed({
    model: config.embeddings.model,
    input: text,
  })
  return response.embeddings[0]
}

const composeQueryVector = async (
  signal: AbortSignal,
  queryText: string | undefined,
  negativeQuery: string | undefined,
  likeSessionCentroids: ResolvedCentroid[] = [],
  unlikeSessionCentroids: ResolvedCentroid[] = [],
  likeProjectCentroids: ResolvedCentroid[] = [],
  unlikeProjectCentroids: ResolvedCentroid[] = []
) => {
  let vec = queryText ? await getQueryEmbedding(queryText, signal) : new Array(1024).fill(0)

  if (negativeQuery) vec = subtractVectors(vec, await getQueryEmbedding(negativeQuery, signal))

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

const CURRENT_SNAPSHOT = 'EXISTS (SELECT 1 FROM ingest_heads ih WHERE ih.current_session_id = s.id)'

type SessionRow = SessionFields & {
  is_current_snapshot?: boolean
  message_count: number
}

// Automated sessions are excluded unless explicitly opted in via includeAutomated.
const AUTOMATED_FILTER = `($2::boolean OR s.is_automated = false)`

const SESSION_QUERY = `
  SELECT s.id, s.title, s.summary, ${CURRENT_SNAPSHOT} AS is_current_snapshot, p.name as project_name, p.path as project_path,
         src.name as source_name, COALESCE(p.data_class, src.data_class) as data_class,
         s.started_at, s.ended_at, s.message_count, p.id as project_id
  FROM sessions s
  JOIN projects p ON s.project_id = p.id
  JOIN sources src ON p.source_id = src.id
  WHERE s.deleted_at IS NULL`

// One query per tier for every hit Chroma returned, keyed by the hit's id so
// the caller can walk the hits in distance order. Keys are strings because pg
// returns BIGINT ids as strings; the rows themselves are passed through as-is.
const hydrate = async <R extends pg.QueryResultRow>(
  sql: string,
  ids: number[],
  includeAutomated: boolean,
  idOf: (row: R) => number | string
): Promise<Map<string, R>> => {
  if (ids.length === 0) return new Map()
  const result = await query<R>(sql, [ids, includeAutomated])
  return new Map(result.rows.map((row) => [String(idOf(row)), row]))
}

const getSessionsByIds = (sessionIds: number[], includeAutomated: boolean) =>
  hydrate<SessionRow>(
    `${SESSION_QUERY} AND ${AUTOMATED_FILTER} AND s.id = ANY($1::int[])`,
    sessionIds,
    includeAutomated,
    (row) => row.id
  )

type MessageAnchoredRow = SessionRow & { message_id: number; content_text: string | null }

const getSessionsByMessageIds = (messageIds: number[], includeAutomated: boolean) =>
  hydrate<MessageAnchoredRow>(
    `SELECT s.id, s.title, s.summary, ${CURRENT_SNAPSHOT} AS is_current_snapshot, p.name as project_name, p.path as project_path,
            src.name as source_name, COALESCE(p.data_class, src.data_class) as data_class,
            s.started_at, s.ended_at, s.message_count, p.id as project_id,
            m.id as message_id, m.content_text
     FROM messages m
     JOIN sessions s ON m.session_id = s.id
     JOIN projects p ON s.project_id = p.id
     JOIN sources src ON p.source_id = src.id
     WHERE m.id = ANY($1::bigint[]) AND s.deleted_at IS NULL AND ${AUTOMATED_FILTER}`,
    messageIds,
    includeAutomated,
    (row) => row.message_id
  )

type ChunkAnchoredRow = SessionRow & { chunk_id: number; chunk_index: number; chunk_summary: string }

const getSessionsByChunkIds = (chunkIds: number[], includeAutomated: boolean) =>
  hydrate<ChunkAnchoredRow>(
    `SELECT s.id, s.title, s.summary, ${CURRENT_SNAPSHOT} AS is_current_snapshot, p.name as project_name, p.path as project_path,
            src.name as source_name, COALESCE(p.data_class, src.data_class) as data_class,
            s.started_at, s.ended_at, s.message_count, p.id as project_id,
            c.id as chunk_id, c.chunk_index, c.summary as chunk_summary
     FROM session_chunks c
     JOIN sessions s ON c.session_id = s.id
     JOIN projects p ON s.project_id = p.id
     JOIN sources src ON p.source_id = src.id
     WHERE c.id = ANY($1::bigint[]) AND s.deleted_at IS NULL AND ${AUTOMATED_FILTER}`,
    chunkIds,
    includeAutomated,
    (row) => row.chunk_id
  )

// How each vector tier names its hits, finds their rows, and reads evidence
// and snippet text off a row.
type VectorTier<R extends SessionRow> = {
  arm: Exclude<Arm, 'lexical'>
  collection: () => string
  idOf: (vectorId: string) => number
  hydrate: (ids: number[], includeAutomated: boolean) => Promise<Map<string, R>>
  evidence: (row: R, rank: number, cosine: number) => Evidence
  text: (row: R) => string | null
  // The tag filter can hide one message without hiding its session.
  messageIdOf?: (row: R) => number
}

const SESSION_TIER: VectorTier<SessionRow> = {
  arm: 'session',
  collection: () => config.chroma.collections.sessions,
  idOf: sessionIdFromVectorId,
  hydrate: getSessionsByIds,
  evidence: (_row, rank, cosine) => ({ arm: 'session', rank, cosine }),
  text: (row) => row.summary,
}

const CHUNK_TIER: VectorTier<ChunkAnchoredRow> = {
  arm: 'chunk',
  collection: () => config.chroma.collections.chunks,
  idOf: (id) => parseInt(id.replace('chunk-', '')),
  hydrate: getSessionsByChunkIds,
  evidence: (row, rank, cosine) => ({ arm: 'chunk', rank, cosine, chunkIndex: row.chunk_index }),
  text: (row) => row.chunk_summary,
}

const MESSAGE_TIER: VectorTier<MessageAnchoredRow> = {
  arm: 'message',
  collection: () => config.chroma.collections.messages,
  idOf: (id) => parseInt(id.replace('msg-', '')),
  hydrate: getSessionsByMessageIds,
  evidence: (row, rank, cosine) => ({ arm: 'message', rank, cosine, messageId: row.message_id }),
  text: (row) => row.content_text,
  messageIdOf: (row) => row.message_id,
}

type FullTextRow = Omit<SessionFields, 'id'> & {
  session_id: number
  message_id: number
  message_count: number
  rank: number
  headline: string
}

// How many hits each arm asks for. Chroma knows nothing about data classes, so
// an active class filter can starve the semantic arms (~70% of sessions may be
// filtered out after the fetch); the limit-relative pools over-fetch harder
// when a filter is on.
const candidatePool = (arm: Arm, limit: number, classFiltered: boolean) => {
  if (arm === 'lexical') return limit * 2
  return limit * (classFiltered ? 5 : arm === 'session' ? 2 : 3)
}

// One candidate per session, in order of first appearance across the arms in
// ARMS order. That order is the tie-break among equal scores, as it has always
// been, so it must not depend on which arm finished first.
const collect = (runs: ArmRun[]): Map<number, Candidate> => {
  const candidates = new Map<number, Candidate>()
  for (const run of runs)
    for (const hit of run.hits) {
      const known = candidates.get(hit.session.id)
      if (!known) {
        candidates.set(hit.session.id, {
          session: hit.session,
          evidence: [hit.evidence],
          texts: { [run.arm]: hit.text },
          headline: hit.headline,
        })
        continue
      }
      known.evidence.push(hit.evidence)
      known.texts[run.arm] = hit.text
      known.headline ??= hit.headline
    }
  return candidates
}

const resolveCentroids = async (table: 'sessions' | 'projects', weightedIds: WeightedId[]) => {
  if (weightedIds.length === 0) return []
  const resolved: ResolvedCentroid[] = []

  for (const { id, weight } of weightedIds) {
    const numId = parseInt(id)
    if (isNaN(numId)) continue

    const result = await query<{ centroid_vector: string | null }>(
      `SELECT centroid_vector FROM ${table} WHERE id = $1 AND centroid_vector IS NOT NULL ${table === 'sessions' ? 'AND deleted_at IS NULL' : ''}`,
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

// The credited evidence decides where a result points: its tier and cursor,
// and which arm's text the snippet is cut from. A full-text match is a message.
const TIER: Record<Arm, MatchedTier> = { session: 'session', chunk: 'chunk', message: 'message', lexical: 'message' }

const cursorOf = (evidence: Evidence): SearchCursor | undefined => {
  if (evidence.arm === 'chunk') return { chunk_index: evidence.chunkIndex }
  if (evidence.arm === 'message' || evidence.arm === 'lexical') return { message_id: evidence.messageId }
  return undefined
}

const toSearchResult = ({ session, texts, headline }: Candidate, { sessionId: _, ...scored }: Scored): SearchResult => {
  const [credited] = scored.evidence
  const cursor = cursorOf(credited)
  const noise = scored.adjustments.find((a) => a.kind === 'noise')
  return {
    session_id: session.id,
    project_name: session.project_name,
    project_path: session.project_path,
    source: session.source_name,
    data_class: session.data_class,
    ...resolveTitleFields(session),
    date: lastActivity(session),
    matched_tier: TIER[credited.arm],
    // The full-text headline wins whenever that arm matched, because it is the
    // window that shows the query's words.
    snippet: buildSnippet(texts[credited.arm] ?? null, headline),
    ...(cursor ? { cursor } : {}),
    noise_damping: noise?.kind === 'noise' ? noise.factor : null,
    ...scored,
  }
}

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
  if (!params.includeUnsummarized && session.summary === null && !session.is_current_snapshot) return false
  if (dataClasses && !dataClasses.includes(session.data_class)) return false
  if (params.source && session.source_name !== params.source) return false
  if (sinceDate && lastActivity(session) < sinceDate) return false
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
  // `unavailable` is transient (the gate said no, Ollama timed out) and worth
  // retrying; `switched-off` is someone's deliberate choice and is not.
  cause: 'unavailable' | 'switched-off'
  reason: string
}

const SWITCHED_OFF: SearchDegradation = {
  semantic: false,
  cause: 'switched-off',
  reason: 'semantic search is switched off in mindmeld; it stays off until someone switches it back on',
}

// Each stage's own wall time, null when it did not run. semanticMs spans the
// embed and the three tiers, which run concurrently with each other and with
// full text, so none of these sum to the search's total.
export type ArmMs = {
  semanticMs: number | null
  embedMs: number | null
  sessionMs: number | null
  chunkMs: number | null
  messageMs: number | null
  fullTextMs: number | null
}

export type SearchOutcome = {
  results: SearchResult[]
  degraded: SearchDegradation | null
  // The projects the cwd resolved to (empty without one), so a caller labelling
  // results by project does not resolve the cwd a second time.
  projectIds: number[]
  armMs: ArmMs
}

// Every hit is scored by its session's summary vector, whichever arm found it,
// so a full-text-only hit is judged like any other. Unreadable vectors cost the
// penalty for this search, never the search itself.
const scoringVectors = async (sessionIds: number[]): Promise<Map<number, number[]>> => {
  try {
    return await sessionVectors(sessionIds)
  } catch (e) {
    console.error('Session vectors unavailable, ranking penalty skipped for this search:', e)
    return new Map()
  }
}

export const searchWithDiagnostics = async (params: SearchParams): Promise<SearchOutcome> => {
  const limit = params.limit ?? 8
  const mode = params.mode ?? DEFAULT_SEARCH_MODE
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

  // includeNoise:true lifts BOTH halves of the noise machinery -- the outright
  // hiding above and the ranking penalty below. Half an escape hatch is not an
  // escape hatch: someone debugging why a session was demoted needs to see it
  // where it would otherwise have ranked, not merely to see it at all.
  //
  // Asking for the "useless" tag by name also counts as asking for noise. A
  // search for tags:["useless"] that then ranked every result down by its
  // resemblance to "useless" would be fighting itself. includeAutomated is the
  // same request: automated sessions are part of the noise corpus, so the
  // penalty would demote exactly what was asked for.
  // With the semantic switch off nothing here touches a vector: no query
  // embedding, no Chroma, and no noise penalty, which scores hits by their
  // session vectors. Asked once, so every arm agrees.
  const vectorsOn = await semanticEnabled()
  const wantsNoisePenalty =
    vectorsOn &&
    params.includeNoise !== true && !tagFilter.includeTags.includes(USELESS_TAG) && !includeAutomated
  const poolFor = (arm: Arm) => candidatePool(arm, limit, dataClasses !== null)

  const [likeSessionCentroids, unlikeSessionCentroids, likeProjectCentroids, unlikeProjectCentroids] =
    await Promise.all([
      resolveCentroids('sessions', params.likeSession ? parseWeightedIds(params.likeSession) : []),
      resolveCentroids('sessions', params.unlikeSession ? parseWeightedIds(params.unlikeSession) : []),
      resolveCentroids('projects', params.likeProject ? parseWeightedIds(params.likeProject) : []),
      resolveCentroids('projects', params.unlikeProject ? parseWeightedIds(params.unlikeProject) : []),
    ])

  let degraded: SearchDegradation | null = null
  // A failed full-text arm fails the whole search at once, so the semantic
  // arms still running are abandoned: the query embedding gives up its Ollama
  // slot, and a tier whose Chroma answer arrives afterwards skips hydration.
  const abandon = new AbortController()

  // Each tier reads only its own hits, so the three run at once.
  const vectorTier = async <R extends SessionRow>(tier: VectorTier<R>, embedding: number[]): Promise<ArmRun | null> => {
    const found = await querySimilar(tier.collection(), embedding, poolFor(tier.arm))
    abandon.signal.throwIfAborted()
    if (!found.ids[0]) return null
    const ids = found.ids[0].map(tier.idOf)
    const rows = await tier.hydrate(ids, includeAutomated)
    // Chroma answers nearest first, so a session's first appearance is its
    // best hit in this tier.
    const seen = new Set<number>()
    const hits: ArmHit[] = []
    for (let i = 0; i < ids.length; i++) {
      const row = rows.get(String(ids[i]))
      if (!row) continue
      if (!passesFilters(row, params, sinceDate, projectIds, dataClasses, tagFilter, tier.messageIdOf?.(row))) continue
      if (seen.has(row.id)) continue
      seen.add(row.id)
      const cosine = 1 - (found.distances?.[0]?.[i] ?? 1)
      hits.push({ session: row, evidence: tier.evidence(row, hits.length + 1, cosine), text: tier.text(row), headline: null })
    }
    return { arm: tier.arm, hits }
  }

  const armMs: ArmMs = { semanticMs: null, embedMs: null, sessionMs: null, chunkMs: null, messageMs: null, fullTextMs: null }
  const timed = async <T>(stage: keyof ArmMs, run: () => Promise<T>): Promise<T> => {
    const started = performance.now()
    try {
      return await run()
    } finally {
      armMs[stage] = performance.now() - started
    }
  }

  // Settled in arm order. A failed embedding is the one entry, since no tier
  // can run without the vector; this never rejects.
  const semanticArms = async (): Promise<PromiseSettledResult<ArmRun | null>[]> => {
    try {
      const embedding = await timed('embedMs', () => composeQueryVector(
        abandon.signal,
        params.query,
        params.negativeQuery,
        likeSessionCentroids,
        unlikeSessionCentroids,
        likeProjectCentroids,
        unlikeProjectCentroids
      ))
      return await Promise.allSettled([
        timed('sessionMs', () => vectorTier(SESSION_TIER, embedding)),
        timed('chunkMs', () => vectorTier(CHUNK_TIER, embedding)),
        timed('messageMs', () => vectorTier(MESSAGE_TIER, embedding)),
      ])
    } catch (reason) {
      return [{ status: 'rejected', reason }]
    }
  }

  const fullTextRows = async (): Promise<ArmRun> => {
    const conditions = [
      `to_tsvector('english', m.content_text) @@ websearch_to_tsquery('english', $1)`,
      `s.deleted_at IS NULL`,
      `($2::text IS NULL OR src.name = $2)`,
      `($3::timestamptz IS NULL OR ${LAST_ACTIVITY_SQL} >= $3)`,
      `($4::boolean OR s.is_automated = false)`,
    ]
    if (!params.includeUnsummarized) conditions.push(`(s.summary IS NOT NULL OR ${CURRENT_SNAPSHOT})`)
    const values: unknown[] = [params.query, params.source ?? null, sinceDate, includeAutomated]
    let nextParam = 5

    if (params.projectOnly && projectIds.length > 0) {
      conditions.push(`s.project_id = ANY($${nextParam++}::int[])`)
      values.push(projectIds)
    }

    if (dataClasses) {
      conditions.push(`s.project_id = ANY($${nextParam++}::int[])`)
      values.push(await projectIdsInDataClasses(dataClasses))
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

    values.push(poolFor('lexical'))
    const limitParam = `$${nextParam}`

    const result = await query<FullTextRow>(
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
        -- A tie inside a session would otherwise let the plan pick which
        -- message the cursor and snippet point at. The earliest one wins.
        ORDER BY m.session_id, rank DESC, m.id
      )
      SELECT rm.session_id, rm.message_id, s.title, s.summary, p.name as project_name, p.path as project_path,
             src.name as source_name, COALESCE(p.data_class, src.data_class) as data_class,
             s.started_at, s.ended_at, s.message_count, rm.rank,
             p.id as project_id,
             ts_headline('english', rm.content_text, websearch_to_tsquery('english', $1), '${ts_headline_options}') as headline
      FROM ranked_messages rm
      JOIN sessions s ON rm.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      JOIN sources src ON p.source_id = src.id
      -- ts_rank ties are common (short messages saturate it), and without a
      -- tie-break which tied session makes the cut depended on the plan. The
      -- most recently indexed session wins a tie.
      ORDER BY rm.rank DESC, rm.session_id DESC
      LIMIT ${limitParam}`,
      values
    )
    // Rows arrive one per session, best first: their order is this arm's ranking.
    const hits = result.rows.map(
      (row, i): ArmHit => ({
        session: { ...row, id: row.session_id },
        evidence: { arm: 'lexical', rank: i + 1, tsRank: row.rank, messageId: row.message_id },
        text: null,
        headline: row.headline,
      })
    )
    return { arm: 'lexical', hits }
  }

  const wantsSemantic = mode === 'semantic' || mode === 'hybrid'
  if (wantsSemantic && !vectorsOn) degraded = SWITCHED_OFF
  const [semantic, fullText] = await Promise.all([
    wantsSemantic && vectorsOn ? timed('semanticMs', semanticArms) : [],
    (mode === 'text' || mode === 'hybrid') && params.query
      ? timed('fullTextMs', fullTextRows).catch((error: unknown) => {
          abandon.abort(error)
          throw error
        })
      : null,
  ])

  // A failed tier ends the semantic block there and keeps the tiers before
  // it, as when they ran one after another.
  const runs: ArmRun[] = []
  for (const arm of semantic) {
    if (arm.status === 'rejected') {
      // Reached in seconds now rather than after ~120s of retrying a shut gate:
      // getQueryEmbedding uses the interactive client, which does not wait one
      // out. The reason travels with the results instead of only to the log.
      const reason = arm.reason instanceof Error ? arm.reason.message : String(arm.reason)
      console.error('Semantic search failed, returning full-text results only:', reason)
      degraded = { semantic: false, cause: 'unavailable', reason }
      break
    }
    if (arm.value) runs.push(arm.value)
  }
  if (fullText) runs.push(fullText)

  const candidates = collect(runs)
  const fused = fuseRanks(runs.map((run) => run.hits.map((hit) => hit.session.id)))

  // Fetched once per search, not once per hit: building the model re-reads
  // the whole noise corpus, and it is cached in noise.ts across searches. An
  // empty model (nothing counts as noise yet, or the corpus is unreadable)
  // damps nothing, so this whole block is a no-op on a corpus nobody judged.
  const noise: NoiseModel = wantsNoisePenalty ? await getNoiseModel() : NO_NOISE
  const hitVectors = noise.centroids.length > 0 ? await scoringVectors([...candidates.keys()]) : new Map()

  const results = [...candidates.values()].map((candidate) => {
    const sessionId = candidate.session.id
    const vector = hitVectors.get(sessionId)
    const similarity = vector ? nearestSimilarity(vector, noise.centroids) : null
    // Damping comes before the project boost. A hit in the current project
    // stays surfaced even if it looks a little like noise -- "in the project I
    // am standing in" is evidence the penalty has no business overruling --
    // while noise from elsewhere is pushed down by the full factor.
    const adjustments: Adjustment[] = [
      ...(similarity === null ? [] : [{ kind: 'noise' as const, similarity, factor: dampingAt(similarity, noise.floor) }]),
      ...(projectIds.includes(candidate.session.project_id) ? [{ kind: 'project' as const, boost: PROJECT_BOOST }] : []),
    ]
    const base = fused.get(sessionId) ?? 0
    const [best, ...rest] = [...candidate.evidence].sort(byStrength)
    return toSearchResult(candidate, {
      sessionId,
      evidence: [best, ...rest],
      base,
      adjustments,
      score: scoreOf(base, adjustments),
    })
  })
  results.sort((a, b) => b.score - a.score)

  // Decorate only the page actually returned, so a wide candidate set costs
  // one small query rather than one per discarded hit.
  const page = results.slice(0, limit)
  const tagsBySession = await getSessionTags(page.map((r) => r.session_id))
  const tagged = page.map((result) => {
    const tags = tagsBySession.get(result.session_id)
    return tags && tags.length > 0 ? { ...result, tags } : result
  })

  return { results: tagged, degraded, projectIds, armMs }
}

// The plain form, for callers that have nothing useful to do with the
// diagnostics. Everything user-facing should prefer searchWithDiagnostics and
// say when the answer was only half-computed.
export const search = async (params: SearchParams): Promise<SearchResult[]> =>
  (await searchWithDiagnostics(params)).results

// An LLM reading this cannot see the log line, and "no results" reads as "this
// conversation does not exist" — a conclusion it will then act on. So a
// degraded search says so in the text, including when it found nothing.
export const FULL_TEXT_ONLY = 'full-text results only'
const degradedNote = (degraded: SearchDegradation | null) => {
  if (!degraded) return ''
  const missing =
    'Meaning-based matches are missing, so absence here is not evidence a conversation does not exist.'
  return degraded.cause === 'switched-off'
    ? `\n\nNOTE: ${FULL_TEXT_ONLY} — ${degraded.reason}. ${missing} Retrying will not help until it is switched back on.`
    : `\n\nNOTE: ${FULL_TEXT_ONLY} — semantic search was unavailable (${degraded.reason}). ${missing} Retry shortly for a full search.`
}

// A report teaches the ranker what noise looks like, so a report on a real but
// off-topic session demotes real work that resembles it. The note has to say
// that as loudly as it asks for reports.
export const NOISE_CHECK = 'NOISE CHECK'
const noiseNote = (results: SearchResult[]) => {
  const suspects = results.filter((r) => r.noise_damping != null && r.noise_damping < config.noise.nudgeBelow)
  if (suspects.length === 0) return ''
  return `\n\n${NOISE_CHECK}: sessions ${suspects.map((r) => r.session_id).join(', ')} resemble known noise (damped below ×${config.noise.nudgeBelow}). If one IS noise (automated runs, monitoring/briefing output, boilerplate, notification stubs, tool-call spam), call reportUselessSession(sessionId, reason).
NEVER report a session just because it is off-topic for this query: a report teaches search that sessions like it are noise and demotes real work that resembles it.`
}

export type FormatOptions = {
  degraded?: SearchDegradation | null
  // The search's list handle, shown on the first line so a follow-up can pass it.
  list?: string | null
  // Append each result's score breakdown: the fused base, every adjustment,
  // and the full-text rank value.
  explain?: boolean
}

export const formatSearchResults = (
  results: SearchResult[],
  { degraded = null, list = null, explain = false }: FormatOptions = {}
) => {
  if (results.length === 0) return `No matching conversations found.${degradedNote(degraded)}`

  const output = results
    .map((r, i) => {
      const projectLabel = r.adjustments.some((a) => a.kind === 'project') ? ' [CURRENT PROJECT]' : ''
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
      const noise = r.noise_damping != null && r.noise_damping < 1 ? `\n   Noise: ×${r.noise_damping.toFixed(3)}` : ''
      const breakdown = explain ? `\n   Why: ${formatBreakdown(r)}` : ''
      return `${i + 1}. **${heading}**${projectLabel}
   Session ID: ${r.session_id}
   Project: ${r.project_name} (${r.source}, ${r.data_class})
   Date: ${r.date.toISOString().split('T')[0]}
   Score: ${r.score.toFixed(3)} | Matched: ${r.matched_tier} (${formatEvidence(r.evidence)})${cursor}${tags}${noise}${breakdown}
   ${r.snippet ?? '(no snippet)'}`
    })
    .join('\n\n')

  const handle = list ? ` (list ${list})` : ''
  return `Found ${results.length} relevant conversations${handle}:\n\n${output}${noiseNote(results)}${degradedNote(degraded)}`
}
