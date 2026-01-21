import assert from 'node:assert'
import { query } from '../db/postgres.js'
import { querySimilar } from '../db/chroma.js'
import { config } from '../config.js'
import { Ollama } from 'ollama'
import { subtractVectors, normalizeVector, addVectors, scaleVector } from '../utils/vector-math.js'

const ollama = new Ollama({ host: config.ollama.url })

// Rocchio algorithm dampening factor for negative weights
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
  snippet: string
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
        const possibleWeight = trimmed.slice(colonIndex + 1)
        const weight = Number.parseFloat(possibleWeight)
        if (!Number.isNaN(weight)) {
          return { id: trimmed.slice(0, colonIndex), weight }
        }
      }
      return { id: trimmed, weight: 1.0 }
    })
    .filter((item) => item.id.length > 0)

const getQueryEmbedding = async (text: string): Promise<number[]> => {
  const response = await ollama.embed({
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
): Promise<number[]> => {
  let queryVector = queryText
    ? await getQueryEmbedding(queryText)
    : new Array(1024).fill(0)

  if (negativeQuery) {
    const negativeEmbedding = await getQueryEmbedding(negativeQuery)
    queryVector = subtractVectors(queryVector, negativeEmbedding)
  }

  for (const { centroid, weight } of likeSessionCentroids) {
    queryVector = addVectors(queryVector, scaleVector(centroid, weight))
  }

  for (const { centroid, weight } of unlikeSessionCentroids) {
    const effectiveWeight = weight * UNLIKE_DAMPENING
    queryVector = subtractVectors(queryVector, scaleVector(centroid, effectiveWeight))
  }

  for (const { centroid, weight } of likeProjectCentroids) {
    queryVector = addVectors(queryVector, scaleVector(centroid, weight))
  }

  for (const { centroid, weight } of unlikeProjectCentroids) {
    const effectiveWeight = weight * UNLIKE_DAMPENING
    queryVector = subtractVectors(queryVector, scaleVector(centroid, effectiveWeight))
  }

  return normalizeVector(queryVector)
}

const findProjectsByPath = async (cwd: string) => {
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

const resolveSessionCentroids = async (weightedIds: WeightedId[]): Promise<ResolvedCentroid[]> => {
  if (weightedIds.length === 0) return []
  const resolved: ResolvedCentroid[] = []

  for (const { id, weight } of weightedIds) {
    const sessionId = parseInt(id)
    if (isNaN(sessionId)) continue

    const result = await query<{ centroid_vector: string | null }>(
      `SELECT centroid_vector FROM sessions WHERE id = $1 AND centroid_vector IS NOT NULL`,
      [sessionId]
    )

    if (result.rows[0]?.centroid_vector) {
      const centroid = JSON.parse(result.rows[0].centroid_vector) as number[]
      resolved.push({ id, weight, centroid })
    }
  }
  return resolved
}

const resolveProjectCentroids = async (weightedIds: WeightedId[]): Promise<ResolvedCentroid[]> => {
  if (weightedIds.length === 0) return []
  const resolved: ResolvedCentroid[] = []

  for (const { id, weight } of weightedIds) {
    const projectId = parseInt(id)
    if (isNaN(projectId)) continue

    const result = await query<{ centroid_vector: string | null }>(
      `SELECT centroid_vector FROM projects WHERE id = $1 AND centroid_vector IS NOT NULL`,
      [projectId]
    )

    if (result.rows[0]?.centroid_vector) {
      const centroid = JSON.parse(result.rows[0].centroid_vector) as number[]
      resolved.push({ id, weight, centroid })
    }
  }
  return resolved
}

export const search = async (params: SearchParams): Promise<SearchResult[]> => {
  const limit = params.limit ?? 20
  const mode = params.mode ?? 'hybrid'

  if (!params.query && !params.likeSession && !params.likeProject && !params.unlikeSession && !params.unlikeProject) {
    throw new Error('Must provide either query or centroid parameters')
  }

  const matchingProjects = params.cwd ? await findProjectsByPath(params.cwd) : []
  const projectIds = matchingProjects.map((p) => p.id)

  const likeSessionIds = params.likeSession ? parseWeightedIds(params.likeSession) : []
  const unlikeSessionIds = params.unlikeSession ? parseWeightedIds(params.unlikeSession) : []
  const likeProjectIds = params.likeProject ? parseWeightedIds(params.likeProject) : []
  const unlikeProjectIds = params.unlikeProject ? parseWeightedIds(params.unlikeProject) : []

  const [likeSessionCentroids, unlikeSessionCentroids, likeProjectCentroids, unlikeProjectCentroids] = await Promise.all([
    resolveSessionCentroids(likeSessionIds),
    resolveSessionCentroids(unlikeSessionIds),
    resolveProjectCentroids(likeProjectIds),
    resolveProjectCentroids(unlikeProjectIds),
  ])

  let sinceDate: Date | null = null
  if (params.since) {
    const match = params.since.match(/^(\d+)([dhwm])$/)
    if (match) {
      const [, num, unit] = match
      const ms = { d: 86400000, h: 3600000, w: 604800000, m: 2592000000 }[unit] ?? 86400000
      sinceDate = new Date(Date.now() - parseInt(num) * ms)
    } else {
      sinceDate = new Date(params.since)
    }
  }

  const results: SearchResult[] = []

  // Semantic search via Chroma
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

      const chromaResults = await querySimilar(
        config.chroma.collections.sessions,
        embedding,
        limit * 2
      )

      if (chromaResults.ids[0]) {
        for (let i = 0; i < chromaResults.ids[0].length; i++) {
          const sessionId = parseInt(chromaResults.ids[0][i].replace('session-', ''))
          const distance = chromaResults.distances?.[0]?.[i] ?? 1
          const score = 1 - distance

          const sessionResult = await query<{
            id: number
            title: string
            project_name: string
            project_path: string
            source_name: string
            started_at: Date
            message_count: number
            project_id: number
          }>(
            `SELECT s.id, s.title, p.name as project_name, p.path as project_path,
                    src.name as source_name, s.started_at, s.message_count, p.id as project_id
             FROM sessions s
             JOIN projects p ON s.project_id = p.id
             JOIN sources src ON p.source_id = src.id
             WHERE s.id = $1 AND s.deleted_at IS NULL`,
            [sessionId]
          )

          if (sessionResult.rows[0]) {
            const session = sessionResult.rows[0]
            if (params.source && session.source_name !== params.source) continue
            if (sinceDate && session.started_at < sinceDate) continue
            if (params.projectOnly && !projectIds.includes(session.project_id)) continue

            const projectBoost = projectIds.includes(session.project_id) ? 0.5 : 0

            results.push({
              session_id: session.id,
              project_name: session.project_name,
              project_path: session.project_path,
              source: session.source_name,
              title: session.title ?? 'Untitled',
              snippet: chromaResults.documents?.[0]?.[i]?.slice(0, 300) ?? '',
              timestamp: session.started_at,
              score: score + projectBoost,
              message_count: session.message_count,
            })
          }
        }
      }
    } catch (e) {
      console.error('Semantic search failed:', e)
    }
  }

  // Full-text search via Postgres
  if ((mode === 'text' || mode === 'hybrid') && params.query) {
    const ftsResult = await query<{
      session_id: number
      title: string
      project_name: string
      project_path: string
      source_name: string
      started_at: Date
      message_count: number
      snippet: string
      rank: number
      project_id: number
    }>(
      `WITH ranked_messages AS (
        SELECT DISTINCT ON (m.session_id)
          m.session_id,
          ts_rank(to_tsvector('english', m.content_text), plainto_tsquery('english', $1)) as rank,
          substring(m.content_text, 1, 300) as snippet
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        JOIN projects p ON s.project_id = p.id
        JOIN sources src ON p.source_id = src.id
        WHERE to_tsvector('english', m.content_text) @@ plainto_tsquery('english', $1)
          AND s.deleted_at IS NULL
          AND ($2::text IS NULL OR src.name = $2)
          AND ($3::timestamptz IS NULL OR s.started_at >= $3)
        ORDER BY m.session_id, rank DESC
      )
      SELECT rm.session_id, s.title, p.name as project_name, p.path as project_path,
             src.name as source_name, s.started_at, s.message_count, rm.snippet, rm.rank,
             p.id as project_id
      FROM ranked_messages rm
      JOIN sessions s ON rm.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      JOIN sources src ON p.source_id = src.id
      ORDER BY rm.rank DESC
      LIMIT $4`,
      [params.query, params.source ?? null, sinceDate, limit * 2]
    )

    for (const row of ftsResult.rows) {
      if (!results.find((r) => r.session_id === row.session_id)) {
        const projectBoost = projectIds.includes(row.project_id) ? 0.5 : 0
        results.push({
          session_id: row.session_id,
          project_name: row.project_name,
          project_path: row.project_path,
          source: row.source_name,
          title: row.title ?? 'Untitled',
          snippet: row.snippet,
          timestamp: row.started_at,
          score: row.rank + projectBoost,
          message_count: row.message_count,
        })
      }
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

export const formatSearchResults = (results: SearchResult[], projectIds: number[] = []): string => {
  if (results.length === 0) return 'No matching conversations found.'

  const output = results.map((r, i) => {
    const projectLabel = projectIds.includes(r.session_id) ? ' [CURRENT PROJECT]' : ''
    assert(r.timestamp, `Missing timestamp for session ${r.session_id}`)
    return `${i + 1}. **${r.title}**${projectLabel}
   Session ID: ${r.session_id}
   Project: ${r.project_name} (${r.source})
   Path: ${r.project_path}
   Date: ${r.timestamp.toISOString().split('T')[0]}
   Messages: ${r.message_count}
   Score: ${r.score.toFixed(3)}
   Preview: ${r.snippet.replace(/\n/g, ' ').slice(0, 200)}...`
  }).join('\n\n')

  return `Found ${results.length} relevant conversations:\n\n${output}`
}
