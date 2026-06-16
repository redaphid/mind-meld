import assert from 'node:assert'
import { query } from '../db/postgres.js'
import { querySimilar } from '../db/chroma.js'
import { config } from '../config.js'
import { getOllamaClient } from '../embeddings/ollama.js'
import { subtractVectors, normalizeVector, addVectors, scaleVector } from '../utils/vector-math.js'
import { fuseRanks, type RankedList } from './rrf.js'
import { buildSnippet, ts_headline_options } from './snippet.js'
import { parseSinceDate } from './since.js'

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
}

export type MatchedTier = 'session' | 'chunk' | 'message'

export type SearchCursor = { chunk_index?: number; message_id?: number }

export type SearchResult = {
  session_id: number
  project_name: string
  project_path: string
  source: string
  title: string
  date: Date
  score: number
  matched_tier: MatchedTier
  snippet: string | null
  cursor?: SearchCursor
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

const getQueryEmbedding = async (text: string) => {
  const response = await getOllamaClient().embed({ model: config.embeddings.model, input: text })
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

export const findProjectsByPath = async (cwd: string) => {
  const result = await query<{ id: number; path: string; name: string; source_name: string }>(
    `SELECT p.id, p.path, p.name, s.name as source_name
     FROM projects p
     JOIN sources s ON p.source_id = s.id
     WHERE p.path IS NOT NULL
       AND ($1 LIKE p.path || '%' OR p.path LIKE $1 || '%')
     ORDER BY LENGTH(p.path) DESC`,
    [cwd]
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
  started_at: Date
  message_count: number
  project_id: number
}

// Automated sessions are excluded unless explicitly opted in via includeAutomated.
const AUTOMATED_FILTER = `($2::boolean OR s.is_automated = false)`

const SESSION_QUERY = `
  SELECT s.id, s.title, s.summary, p.name as project_name, p.path as project_path,
         src.name as source_name, s.started_at, s.message_count, p.id as project_id
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
            src.name as source_name, s.started_at, s.message_count, p.id as project_id,
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
            src.name as source_name, s.started_at, s.message_count, p.id as project_id,
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

const baseResult = (s: SessionRow, score: number, tier: MatchedTier): SearchResult => ({
  session_id: s.id,
  project_name: s.project_name,
  project_path: s.project_path,
  source: s.source_name,
  title: s.title ?? 'Untitled',
  date: s.started_at,
  score,
  matched_tier: tier,
  snippet: null,
})

const passesFilters = (
  session: SessionRow,
  params: { source?: string; projectOnly?: boolean },
  sinceDate: Date | null,
  projectIds: number[]
) => {
  if (params.source && session.source_name !== params.source) return false
  if (sinceDate && session.started_at < sinceDate) return false
  if (params.projectOnly && !projectIds.includes(session.project_id)) return false
  return true
}

export const search = async (params: SearchParams): Promise<SearchResult[]> => {
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

      const sessionHits = await querySimilar(config.chroma.collections.sessions, embedding, limit * 2)
      if (sessionHits.ids[0]) {
        const sessionRanked: RankedList = []
        for (let i = 0; i < sessionHits.ids[0].length; i++) {
          const sessionId = parseInt(sessionHits.ids[0][i].replace('session-', ''))
          const score = 1 - (sessionHits.distances?.[0]?.[i] ?? 1)
          const session = await getSessionById(sessionId, includeAutomated)
          if (!session) continue
          if (!passesFilters(session, params, sinceDate, projectIds)) continue
          record(baseResult(session, score, 'session'), session.project_id, session.summary, null)
          sessionRanked.push(session.id)
        }
        rankedLists.push(sessionRanked)
      }

      const chunkHits = await querySimilar(config.chroma.collections.chunks, embedding, limit * 3)
      if (chunkHits.ids[0]) {
        const chunkRanked: RankedList = []
        const seen = new Set<number>()
        for (let i = 0; i < chunkHits.ids[0].length; i++) {
          const chunkId = parseInt(chunkHits.ids[0][i].replace('chunk-', ''))
          const score = 1 - (chunkHits.distances?.[0]?.[i] ?? 1)
          const session = await getSessionByChunkId(chunkId, includeAutomated)
          if (!session) continue
          if (!passesFilters(session, params, sinceDate, projectIds)) continue
          if (seen.has(session.id)) continue
          seen.add(session.id)
          const result = baseResult(session, score, 'chunk')
          result.cursor = { chunk_index: session.chunk_index }
          record(result, session.project_id, session.chunk_summary, null)
          chunkRanked.push(session.id)
        }
        rankedLists.push(chunkRanked)
      }

      const messageHits = await querySimilar(config.chroma.collections.messages, embedding, limit * 3)
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
          if (!passesFilters(session, params, sinceDate, projectIds)) continue
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
      console.error('Semantic search failed:', e)
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
    const values: unknown[] = [params.query, params.source ?? null, sinceDate, includeAutomated]
    let nextParam = 5

    if (params.projectOnly && projectIds.length > 0) {
      conditions.push(`s.project_id = ANY($${nextParam++}::int[])`)
      values.push(projectIds)
    }

    if (params.excludeTerms) {
      conditions.push(
        `NOT to_tsvector('english', m.content_text) @@ websearch_to_tsquery('english', $${nextParam++})`
      )
      values.push(params.excludeTerms)
    }

    values.push(limit * 2)
    const limitParam = `$${nextParam}`

    const ftsResult = await query<{
      session_id: number
      message_id: number
      title: string | null
      project_name: string
      project_path: string
      source_name: string
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
      SELECT rm.session_id, rm.message_id, s.title, p.name as project_name, p.path as project_path,
             src.name as source_name, s.started_at, s.message_count, rm.rank,
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
        title: row.title ?? 'Untitled',
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
  return results.slice(0, limit)
}

export const formatSearchResults = (results: SearchResult[], projectIds: number[] = []) => {
  if (results.length === 0) return 'No matching conversations found.'

  const output = results
    .map((r, i) => {
      const projectLabel = projectIds.includes(r.session_id) ? ' [CURRENT PROJECT]' : ''
      assert(r.date, `Missing date for session ${r.session_id}`)
      const cursor = r.cursor?.chunk_index != null
        ? `\n   Cursor: chunk ${r.cursor.chunk_index}`
        : r.cursor?.message_id != null
          ? `\n   Cursor: message ${r.cursor.message_id}`
          : ''
      return `${i + 1}. **${r.title}**${projectLabel}
   Session ID: ${r.session_id}
   Project: ${r.project_name} (${r.source})
   Date: ${r.date.toISOString().split('T')[0]}
   Score: ${r.score.toFixed(3)} | Matched: ${r.matched_tier}${cursor}
   ${r.snippet ?? '(no snippet)'}`
    })
    .join('\n\n')

  return `Found ${results.length} relevant conversations:\n\n${output}`
}
