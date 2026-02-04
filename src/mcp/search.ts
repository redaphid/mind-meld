import assert from 'node:assert'
import { query } from '../db/postgres.js'
import { querySimilar } from '../db/chroma.js'
import { config } from '../config.js'
import { Ollama } from 'ollama'
import { subtractVectors, normalizeVector, addVectors, scaleVector } from '../utils/vector-math.js'

const ollama = new Ollama({ host: config.ollama.url })

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
}

export type SearchResult = {
  session_id: number
  project_name: string
  project_path: string
  source: string
  title: string
  summary: string | null
  timestamp: Date
  score: number
  message_count: number
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
  const response = await ollama.embed({ model: config.embeddings.model, input: text })
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
  let vec = queryText
    ? await getQueryEmbedding(queryText)
    : new Array(1024).fill(0)

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
  const result = await query<{
    id: number
    path: string
    name: string
    source_name: string
  }>(
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

const SESSION_QUERY = `
  SELECT s.id, s.title, s.summary, p.name as project_name, p.path as project_path,
         src.name as source_name, s.started_at, s.message_count, p.id as project_id
  FROM sessions s
  JOIN projects p ON s.project_id = p.id
  JOIN sources src ON p.source_id = src.id
  WHERE s.deleted_at IS NULL`

const getSessionById = async (sessionId: number) => {
  const result = await query<SessionRow>(`${SESSION_QUERY} AND s.id = $1`, [sessionId])
  return result.rows[0] ?? null
}

const getSessionByMessageId = async (messageId: number) => {
  const result = await query<SessionRow>(
    `SELECT s.id, s.title, s.summary, p.name as project_name, p.path as project_path,
            src.name as source_name, s.started_at, s.message_count, p.id as project_id
     FROM messages m
     JOIN sessions s ON m.session_id = s.id
     JOIN projects p ON s.project_id = p.id
     JOIN sources src ON p.source_id = src.id
     WHERE m.id = $1 AND s.deleted_at IS NULL`,
    [messageId]
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

    if (result.rows[0]?.centroid_vector) {
      resolved.push({ id, weight, centroid: JSON.parse(result.rows[0].centroid_vector) })
    }
  }
  return resolved
}

const toResult = (session: SessionRow, score: number, projectIds: number[]): SearchResult => ({
  session_id: session.id,
  project_name: session.project_name,
  project_path: session.project_path,
  source: session.source_name,
  title: session.title ?? 'Untitled',
  summary: session.summary,
  timestamp: session.started_at,
  score: score + (projectIds.includes(session.project_id) ? 0.5 : 0),
  message_count: session.message_count,
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

const parseSinceDate = (since?: string) => {
  if (!since) return null
  const match = since.match(/^(\d+)([dhwm])$/)
  if (match) {
    const [, num, unit] = match
    const ms = { d: 86400000, h: 3600000, w: 604800000, m: 2592000000 }[unit] ?? 86400000
    return new Date(Date.now() - parseInt(num) * ms)
  }
  return new Date(since)
}

export const search = async (params: SearchParams): Promise<SearchResult[]> => {
  const limit = params.limit ?? 20
  const mode = params.mode ?? 'hybrid'

  if (!params.query && !params.likeSession && !params.likeProject && !params.unlikeSession && !params.unlikeProject)
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

  const results: SearchResult[] = []
  const seenSessionIds = new Set<number>()

  const addResult = (r: SearchResult) => {
    if (seenSessionIds.has(r.session_id)) return
    seenSessionIds.add(r.session_id)
    results.push(r)
  }

  if (mode === 'semantic' || mode === 'hybrid') {
    try {
      const embedding = await composeQueryVector(
        params.query, params.negativeQuery,
        likeSessionCentroids, unlikeSessionCentroids,
        likeProjectCentroids, unlikeProjectCentroids
      )

      const sessionHits = await querySimilar(config.chroma.collections.sessions, embedding, limit * 2)

      if (sessionHits.ids[0]) {
        for (let i = 0; i < sessionHits.ids[0].length; i++) {
          const sessionId = parseInt(sessionHits.ids[0][i].replace('session-', ''))
          const score = 1 - (sessionHits.distances?.[0]?.[i] ?? 1)
          const session = await getSessionById(sessionId)
          if (!session) continue
          if (!passesFilters(session, params, sinceDate, projectIds)) continue
          addResult(toResult(session, score, projectIds))
        }
      }

      const messageHits = await querySimilar(config.chroma.collections.messages, embedding, limit * 3)

      if (messageHits.ids[0]) {
        const bestBySession = new Map<number, number>()

        for (let i = 0; i < messageHits.ids[0].length; i++) {
          const messageId = parseInt(messageHits.ids[0][i].replace('msg-', ''))
          const score = 1 - (messageHits.distances?.[0]?.[i] ?? 1)
          const session = await getSessionByMessageId(messageId)
          if (!session) continue
          if (seenSessionIds.has(session.id)) continue
          if (!passesFilters(session, params, sinceDate, projectIds)) continue

          const existing = bestBySession.get(session.id)
          if (!existing || score > existing) bestBySession.set(session.id, score)
        }

        for (const [sessionId, score] of bestBySession) {
          const session = await getSessionById(sessionId)
          if (session) addResult(toResult(session, score, projectIds))
        }
      }
    } catch (e) {
      console.error('Semantic search failed:', e)
    }
  }

  if ((mode === 'text' || mode === 'hybrid') && params.query) {
    const conditions = [
      `to_tsvector('english', m.content_text) @@ plainto_tsquery('english', $1)`,
      `s.deleted_at IS NULL`,
      `($2::text IS NULL OR src.name = $2)`,
      `($3::timestamptz IS NULL OR s.started_at >= $3)`,
    ]
    const values: unknown[] = [params.query, params.source ?? null, sinceDate]
    let nextParam = 4

    if (params.projectOnly && projectIds.length > 0) {
      conditions.push(`s.project_id = ANY($${nextParam++}::int[])`)
      values.push(projectIds)
    }

    if (params.excludeTerms) {
      conditions.push(`NOT to_tsvector('english', m.content_text) @@ plainto_tsquery('english', $${nextParam++})`)
      values.push(params.excludeTerms)
    }

    values.push(limit * 2)
    const limitParam = `$${nextParam}`

    const ftsResult = await query<{
      session_id: number
      title: string | null
      summary: string | null
      project_name: string
      project_path: string
      source_name: string
      started_at: Date
      message_count: number
      rank: number
      project_id: number
    }>(
      `WITH ranked_messages AS (
        SELECT DISTINCT ON (m.session_id)
          m.session_id,
          ts_rank(to_tsvector('english', m.content_text), plainto_tsquery('english', $1)) as rank
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        JOIN projects p ON s.project_id = p.id
        JOIN sources src ON p.source_id = src.id
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY m.session_id, rank DESC
      )
      SELECT rm.session_id, s.title, s.summary, p.name as project_name, p.path as project_path,
             src.name as source_name, s.started_at, s.message_count, rm.rank,
             p.id as project_id
      FROM ranked_messages rm
      JOIN sessions s ON rm.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      JOIN sources src ON p.source_id = src.id
      ORDER BY rm.rank DESC
      LIMIT ${limitParam}`,
      values
    )

    for (const row of ftsResult.rows) {
      addResult({
        session_id: row.session_id,
        project_name: row.project_name,
        project_path: row.project_path,
        source: row.source_name,
        title: row.title ?? 'Untitled',
        summary: row.summary,
        timestamp: row.started_at,
        score: row.rank + (projectIds.includes(row.project_id) ? 0.5 : 0),
        message_count: row.message_count,
      })
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

export const formatSearchResults = (results: SearchResult[], projectIds: number[] = []) => {
  if (results.length === 0) return 'No matching conversations found.'

  const output = results.map((r, i) => {
    const projectLabel = projectIds.includes(r.session_id) ? ' [CURRENT PROJECT]' : ''
    assert(r.timestamp, `Missing timestamp for session ${r.session_id}`)
    const summary = r.summary ?? 'No summary available'
    return `${i + 1}. **${r.title}**${projectLabel}
   Session ID: ${r.session_id}
   Project: ${r.project_name} (${r.source})
   Path: ${r.project_path}
   Date: ${r.timestamp.toISOString().split('T')[0]}
   Messages: ${r.message_count}
   Score: ${r.score.toFixed(3)}
   Summary: ${summary}`
  }).join('\n\n')

  return `Found ${results.length} relevant conversations:\n\n${output}`
}
