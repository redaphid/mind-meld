import assert from 'node:assert'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { query, closePool } from '../db/postgres.js'
import { querySimilar, getCollection } from '../db/chroma.js'
import { config } from '../config.js'
import { Ollama } from 'ollama'
import { subtractVectors, normalizeVector, addVectors, scaleVector } from '../utils/vector-math.js'

const ollama = new Ollama({ host: config.ollama.url })

// Rocchio algorithm dampening factor for negative weights
// Prevents over-suppression: negative weights are reduced to 20% of stated value
const UNLIKE_DAMPENING = 0.2

// Types for weighted parameters
type WeightedId = { id: string; weight: number }
type ResolvedCentroid = { id: string; weight: number; centroid: number[] }

/**
 * Parse weighted ID parameters
 * Format: "identifier:weight" or just "identifier" (defaults to weight 1.0)
 * Examples: "session-123", "session-123:0.5", "session-456:2.0"
 */
const parseWeightedIds = (params: string[]): WeightedId[] =>
  params
    .map((item) => {
      const trimmed = item.trim()
      const colonIndex = trimmed.lastIndexOf(':')

      // Check if there's a colon and it's followed by a valid number
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

const server = new McpServer({
  name: 'mindmeld',
  version: '0.1.0',
})

// Helper to get embedding for a query
const getQueryEmbedding = async (text: string): Promise<number[]> => {
  const response = await ollama.embed({
    model: config.embeddings.model,
    input: text,
  })
  return response.embeddings[0]
}

/**
 * Compose query vector with optional negative query and centroid boosting
 * Follows Rocchio algorithm: Q' = Q - γN + Σ(w * C+) - Σ(γw * C-)
 * Where γ = UNLIKE_DAMPENING (0.2)
 */
const composeQueryVector = async (
  query: string | undefined,
  negativeQuery: string | undefined,
  likeSessionCentroids: ResolvedCentroid[] = [],
  unlikeSessionCentroids: ResolvedCentroid[] = [],
  likeProjectCentroids: ResolvedCentroid[] = [],
  unlikeProjectCentroids: ResolvedCentroid[] = []
): Promise<number[]> => {
  // Start with text query embedding or zero vector
  let queryVector = query
    ? await getQueryEmbedding(query)
    : new Array(1024).fill(0) // BGE-M3 dimensions

  // 1. Apply negative text query (vector subtraction)
  if (negativeQuery) {
    const negativeEmbedding = await getQueryEmbedding(negativeQuery)
    queryVector = subtractVectors(queryVector, negativeEmbedding)
  }

  // 2. Apply positive session centroids (weighted addition)
  for (const { id, weight, centroid } of likeSessionCentroids) {
    queryVector = addVectors(queryVector, scaleVector(centroid, weight))
  }

  // 3. Apply negative session centroids (weighted subtraction with dampening)
  for (const { id, weight, centroid } of unlikeSessionCentroids) {
    const effectiveWeight = weight * UNLIKE_DAMPENING
    queryVector = subtractVectors(queryVector, scaleVector(centroid, effectiveWeight))
  }

  // 4. Apply positive project centroids
  for (const { id, weight, centroid } of likeProjectCentroids) {
    queryVector = addVectors(queryVector, scaleVector(centroid, weight))
  }

  // 5. Apply negative project centroids (with dampening)
  for (const { id, weight, centroid } of unlikeProjectCentroids) {
    const effectiveWeight = weight * UNLIKE_DAMPENING
    queryVector = subtractVectors(queryVector, scaleVector(centroid, effectiveWeight))
  }

  // Final normalization
  return normalizeVector(queryVector)
}

// Helper to find projects matching a path (CWD-aware)
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

// Common session info type for DRY queries
type SessionInfo = {
  id: number
  title: string | null
  project_name: string
  project_path: string
  source_name: string
  started_at: Date
  message_count: number
  project_id: number
}

// Base query for active (non-deleted) sessions
const SESSION_BASE_QUERY = `
  SELECT s.id, s.title, p.name as project_name, p.path as project_path,
         src.name as source_name, s.started_at, s.message_count, p.id as project_id
  FROM sessions s
  JOIN projects p ON s.project_id = p.id
  JOIN sources src ON p.source_id = src.id
  WHERE s.deleted_at IS NULL`

// Get active session by ID (excludes soft-deleted)
const getActiveSessionById = async (sessionId: number): Promise<SessionInfo | null> => {
  const result = await query<SessionInfo>(
    `${SESSION_BASE_QUERY} AND s.id = $1`,
    [sessionId]
  )
  return result.rows[0] ?? null
}

// Get active session by message ID (excludes soft-deleted)
const getActiveSessionByMessageId = async (messageId: number): Promise<SessionInfo | null> => {
  const result = await query<SessionInfo>(
    `SELECT s.id, s.title, p.name as project_name, p.path as project_path,
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

/**
 * Resolve session centroids from weighted IDs
 * Fetches centroid vectors from database and validates them
 */
const resolveSessionCentroids = async (
  weightedIds: WeightedId[]
): Promise<ResolvedCentroid[]> => {
  if (weightedIds.length === 0) return []

  const resolved: ResolvedCentroid[] = []

  for (const { id, weight } of weightedIds) {
    const sessionId = parseInt(id)
    if (isNaN(sessionId)) continue

    const result = await query<{
      centroid_vector: string | null
      centroid_message_count: number | null
    }>(
      `SELECT centroid_vector, centroid_message_count
       FROM sessions
       WHERE id = $1 AND centroid_vector IS NOT NULL`,
      [sessionId]
    )

    if (result.rows[0] && result.rows[0].centroid_vector) {
      const centroid = JSON.parse(result.rows[0].centroid_vector) as number[]
      resolved.push({ id, weight, centroid })
    }
  }

  return resolved
}

/**
 * Resolve project centroids from weighted IDs
 * Fetches centroid vectors from database and validates them
 */
const resolveProjectCentroids = async (
  weightedIds: WeightedId[]
): Promise<ResolvedCentroid[]> => {
  if (weightedIds.length === 0) return []

  const resolved: ResolvedCentroid[] = []

  for (const { id, weight } of weightedIds) {
    const projectId = parseInt(id)
    if (isNaN(projectId)) continue

    const result = await query<{
      centroid_vector: string | null
      centroid_message_count: number | null
    }>(
      `SELECT centroid_vector, centroid_message_count
       FROM projects
       WHERE id = $1 AND centroid_vector IS NOT NULL`,
      [projectId]
    )

    if (result.rows[0] && result.rows[0].centroid_vector) {
      const centroid = JSON.parse(result.rows[0].centroid_vector) as number[]
      resolved.push({ id, weight, centroid })
    }
  }

  return resolved
}

// Search tool - hybrid FTS + semantic search
server.tool(
  'search',
  `Search past AI conversations using hybrid full-text + semantic search.

BEST FOR:
- Finding previous discussions about a topic
- Discovering how you solved similar problems before
- Finding code patterns you've used
- Recalling tool usage and workflows

CWD-AWARE:
- Pass your current working directory to prioritize conversations from that project
- Results from the current project are boosted in relevance

SEARCH MODES:
- semantic: Find conceptually similar content (default)
- text: Exact phrase/keyword matching
- hybrid: Combines both approaches

WEIGHTED CENTROID SEARCH:
- likeSession: Boost results similar to specific session(s) style
  Format: ["123"] or ["123:1.5"] for weighted boost
- unlikeSession: Suppress results similar to specific session(s)
- likeProject: Boost results matching specific project(s) topics
- unlikeProject: Suppress results matching specific project(s)

Weight scale: 0.3-0.5 (gentle), 1.0 (default), 1.2-1.5 (strong), 2.0+ (aggressive)`,
  {
    query: z.string().optional().describe('Search query - natural language works best for semantic search (optional when using centroid params)'),
    negativeQuery: z.string().optional().describe('Negative query - pushes results away from this concept (e.g., "slack briefing summaries" to exclude discussion threads)'),
    excludeTerms: z.string().optional().describe('Hard filter - exclude results containing these terms (e.g., "warmup slack briefing" removes those sessions entirely)'),
    cwd: z.string().optional().describe('Current working directory - conversations from matching projects get boosted'),
    mode: z.enum(['semantic', 'text', 'hybrid']).optional().describe('Search mode: semantic (default), text, or hybrid'),
    limit: z.number().optional().describe('Max results to return (default 20)'),
    source: z.string().optional().describe('Filter to specific source'),
    since: z.string().optional().describe('Only include conversations since this time (e.g., "7d", "2024-01-01")'),
    projectOnly: z.boolean().optional().describe('Only search conversations from the CWD project'),
    likeSession: z.array(z.string()).optional().describe('Boost results similar to these session IDs (format: ["123"] or ["123:1.5"] for weighted)'),
    unlikeSession: z.array(z.string()).optional().describe('Suppress results similar to these session IDs'),
    likeProject: z.array(z.string()).optional().describe('Boost results matching these project IDs'),
    unlikeProject: z.array(z.string()).optional().describe('Suppress results matching these project IDs'),
  },
  async (params) => {
    const limit = params.limit ?? 20
    const mode = params.mode ?? 'hybrid'

    // Validate that we have either a query or centroid params
    if (!params.query && !params.likeSession && !params.likeProject && !params.unlikeSession && !params.unlikeProject) {
      throw new Error('Must provide either query or centroid parameters (likeSession, likeProject, etc.)')
    }

    // Find matching projects for CWD boosting
    const matchingProjects = params.cwd ? await findProjectsByPath(params.cwd) : []
    const projectIds = matchingProjects.map((p) => p.id)

    // Parse weighted centroid parameters
    const likeSessionIds = params.likeSession ? parseWeightedIds(params.likeSession) : []
    const unlikeSessionIds = params.unlikeSession ? parseWeightedIds(params.unlikeSession) : []
    const likeProjectIds = params.likeProject ? parseWeightedIds(params.likeProject) : []
    const unlikeProjectIds = params.unlikeProject ? parseWeightedIds(params.unlikeProject) : []

    // Resolve centroids from database (in parallel)
    const [
      likeSessionCentroids,
      unlikeSessionCentroids,
      likeProjectCentroids,
      unlikeProjectCentroids
    ] = await Promise.all([
      resolveSessionCentroids(likeSessionIds),
      resolveSessionCentroids(unlikeSessionIds),
      resolveProjectCentroids(likeProjectIds),
      resolveProjectCentroids(unlikeProjectIds)
    ])

    // Build time filter
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

    const results: Array<{
      session_id: number
      project_name: string
      project_path: string
      source: string
      title: string
      snippet: string
      timestamp: Date
      score: number
      message_count: number
    }> = []

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
          limit * 2 // Over-fetch for filtering
        )

        if (chromaResults.ids[0]) {
          for (let i = 0; i < chromaResults.ids[0].length; i++) {
            const sessionId = parseInt(chromaResults.ids[0][i].replace('session-', ''))
            const distance = chromaResults.distances?.[0]?.[i] ?? 1
            const score = 1 - distance // Convert distance to similarity

            // Get session details (excludes soft-deleted)
            const session = await getActiveSessionById(sessionId)

            if (session) {

              // Apply filters
              if (params.source && session.source_name !== params.source) continue
              if (sinceDate && session.started_at < sinceDate) continue
              if (params.projectOnly && !projectIds.includes(session.project_id)) continue

              // Boost score for matching projects (strong boost to surface local work)
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

        // Search messages in parallel (always, not just as fallback)
        const messageResults = await querySimilar(
          config.chroma.collections.messages,
          embedding,
          limit * 3 // Over-fetch since we'll group by session
        )

        // Group message matches by session
        const sessionIds = new Set(results.map(r => r.session_id))
        const messageSessions = new Map<number, { score: number; snippet: string }>()

        if (messageResults.ids[0]) {
            for (let i = 0; i < messageResults.ids[0].length; i++) {
              const messageId = parseInt(messageResults.ids[0][i].replace('msg-', ''))
              const distance = messageResults.distances?.[0]?.[i] ?? 1
              const score = 1 - distance

              // Get session for this message (excludes soft-deleted)
              const msgSession = await getActiveSessionByMessageId(messageId)

              if (msgSession) {
                const sessionId = msgSession.id

                // Skip if we already have this session from session-level search
                if (sessionIds.has(sessionId)) continue

                // Apply filters
                if (params.source && msgSession.source_name !== params.source) continue
                if (sinceDate && msgSession.started_at < sinceDate) continue
                if (params.projectOnly && !projectIds.includes(msgSession.project_id)) continue

                // Keep best score per session
                const existing = messageSessions.get(sessionId)
                if (!existing || score > existing.score) {
                  messageSessions.set(sessionId, {
                    score,
                    snippet: messageResults.documents?.[0]?.[i]?.slice(0, 300) ?? ''
                  })
                }
              }
            }

            // Add message-sourced sessions to results
            for (const [sessionId, { score, snippet }] of messageSessions.entries()) {
              const session = await getActiveSessionById(sessionId)

              if (session) {
                const projectBoost = projectIds.includes(session.project_id) ? 0.5 : 0

                results.push({
                  session_id: session.id,
                  project_name: session.project_name,
                  project_path: session.project_path,
                  source: session.source_name,
                  title: session.title ?? 'Untitled',
                  snippet: `[message match] ${snippet}`,
                  timestamp: session.started_at,
                  score: score + projectBoost,
                  message_count: session.message_count,
                })
              }
          }
        }
      } catch (e) {
        // Chroma might not be available, fall back to text search
        console.error('Semantic search failed:', e)
      }
    }

    // Full-text search via Postgres
    if (mode === 'text' || mode === 'hybrid') {
      const projectFilter = params.projectOnly && projectIds.length > 0
        ? `AND s.project_id = ANY($4::int[])`
        : ''

      // Build negative FTS filter for hard exclusions
      const excludeFilter = params.excludeTerms
        ? `AND NOT to_tsvector('english', m.content_text) @@ plainto_tsquery('english', $${params.projectOnly && projectIds.length > 0 ? 5 : 4})`
        : ''

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
            AND ($2::text IS NULL OR src.name = $2)
            AND ($3::timestamptz IS NULL OR s.started_at >= $3)
            ${projectFilter}
            ${excludeFilter}
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
        LIMIT $${params.projectOnly && projectIds.length > 0 ? (params.excludeTerms ? 6 : 5) : (params.excludeTerms ? 5 : 4)}`,
        params.projectOnly && projectIds.length > 0
          ? (params.excludeTerms
              ? [params.query, params.source ?? null, sinceDate, projectIds, params.excludeTerms, limit * 2]
              : [params.query, params.source ?? null, sinceDate, projectIds, limit * 2])
          : (params.excludeTerms
              ? [params.query, params.source ?? null, sinceDate, params.excludeTerms, limit * 2]
              : [params.query, params.source ?? null, sinceDate, limit * 2])
      )

      for (const row of ftsResult.rows) {
        // Check if already in results (from semantic search)
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

    // Sort by score and limit
    results.sort((a, b) => b.score - a.score)
    const finalResults = results.slice(0, limit)

    // Format output
    const output = finalResults.map((r, i) => {
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

    return {
      content: [{
        type: 'text',
        text: finalResults.length > 0
          ? `Found ${finalResults.length} relevant conversations:\n\n${output}`
          : 'No matching conversations found.',
      }],
    }
  }
)

// Get session details tool
server.tool(
  'getSession',
  `Get the full conversation from a specific session.

Use after search to dive deep into a relevant conversation.`,
  {
    sessionId: z.number().describe('Session ID from search results'),
    messageLimit: z.number().optional().describe('Max messages to return (default 50)'),
  },
  async (params) => {
    const limit = params.messageLimit ?? 50

    // Get session metadata
    const sessionResult = await query<{
      id: number
      title: string
      project_name: string
      project_path: string
      source_name: string
      started_at: Date
      ended_at: Date
      message_count: number
      model_used: string
      git_branch: string
    }>(
      `SELECT s.id, s.title, p.name as project_name, p.path as project_path,
              src.name as source_name, s.started_at, s.ended_at, s.message_count,
              s.model_used, s.git_branch
       FROM sessions s
       JOIN projects p ON s.project_id = p.id
       JOIN sources src ON p.source_id = src.id
       WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [params.sessionId]
    )

    if (!sessionResult.rows[0]) {
      return { content: [{ type: 'text', text: 'Session not found.' }] }
    }

    const session = sessionResult.rows[0]

    // Get messages
    const messagesResult = await query<{
      role: string
      content_text: string
      tool_name: string
      timestamp: Date
    }>(
      `SELECT role, content_text, tool_name, timestamp
       FROM messages
       WHERE session_id = $1
       ORDER BY timestamp ASC
       LIMIT $2`,
      [params.sessionId, limit]
    )

    assert(session.started_at, `Missing started_at for session ${params.sessionId}`)

    const header = `# ${session.title ?? 'Untitled Session'}

**Project:** ${session.project_name}
**Path:** ${session.project_path}
**Source:** ${session.source_name}
**Model:** ${session.model_used ?? 'Unknown'}
**Branch:** ${session.git_branch ?? 'N/A'}
**Date:** ${session.started_at.toISOString().split('T')[0]}
**Messages:** ${session.message_count}

---
`

    const messages = messagesResult.rows.map((m) => {
      const roleLabel = m.role === 'user' ? '**User:**' : m.role === 'assistant' ? '**Claude:**' : `**${m.role}:**`
      const toolLabel = m.tool_name ? ` [Tool: ${m.tool_name}]` : ''
      const content = m.content_text?.slice(0, 2000) ?? '[No content]'
      return `${roleLabel}${toolLabel}\n${content}`
    }).join('\n\n---\n\n')

    return {
      content: [{
        type: 'text',
        text: header + messages,
      }],
    }
  }
)

// Context prompt - find relevant conversations for current work
server.prompt(
  'context',
  'Find relevant past conversations for your current project',
  {
    cwd: z.string().describe('Your current working directory'),
    task: z.string().optional().describe('Brief description of what you\'re working on'),
  },
  async (params) => {
    const projects = await findProjectsByPath(params.cwd)

    if (projects.length === 0) {
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `No previous conversations found for ${params.cwd}. This appears to be a new project.`,
          },
        }],
      }
    }

    const projectIds = projects.map((p) => p.id)

    // Get recent sessions from matching projects
    const recentResult = await query<{
      id: number
      title: string
      project_name: string
      started_at: Date
      message_count: number
    }>(
      `SELECT s.id, s.title, p.name as project_name, s.started_at, s.message_count
       FROM sessions s
       JOIN projects p ON s.project_id = p.id
       WHERE p.id = ANY($1::int[]) AND s.deleted_at IS NULL
       ORDER BY s.started_at DESC
       LIMIT 10`,
      [projectIds]
    )

    let contextText = `# Previous Conversations for ${projects[0].name}\n\n`
    contextText += `**Path:** ${params.cwd}\n\n`

    if (params.task) {
      contextText += `**Current task:** ${params.task}\n\n`
    }

    contextText += `## Recent Sessions\n\n`

    for (const session of recentResult.rows) {
      assert(session.started_at, `Missing started_at for session ${session.id}`)
      contextText += `- **${session.title ?? 'Untitled'}** (${session.started_at.toISOString().split('T')[0]}) - ${session.message_count} messages [ID: ${session.id}]\n`
    }

    contextText += `\n---\n\nUse the \`search\` tool with your current task description to find more specific relevant conversations.`

    return {
      messages: [{
        role: 'user',
        content: { type: 'text', text: contextText },
      }],
    }
  }
)

// Stats tool
server.tool(
  'stats',
  'Get statistics about your conversation history',
  {},
  async () => {
    const stats = await query<{
      source_name: string
      project_count: number
      session_count: number
      message_count: number
    }>(
      `SELECT src.name as source_name,
              COUNT(DISTINCT p.id) as project_count,
              COUNT(DISTINCT s.id) as session_count,
              COUNT(m.id) as message_count
       FROM sources src
       LEFT JOIN projects p ON p.source_id = src.id
       LEFT JOIN sessions s ON s.project_id = p.id
       LEFT JOIN messages m ON m.session_id = s.id
       GROUP BY src.name`
    )

    const topProjects = await query<{
      name: string
      session_count: number
      message_count: number
    }>(
      `SELECT p.name, COUNT(DISTINCT s.id) as session_count, COUNT(m.id) as message_count
       FROM projects p
       LEFT JOIN sessions s ON s.project_id = p.id
       LEFT JOIN messages m ON m.session_id = s.id
       GROUP BY p.id, p.name
       ORDER BY session_count DESC
       LIMIT 10`
    )

    let output = `# Mindmeld Statistics\n\n## By Source\n\n`

    for (const row of stats.rows) {
      output += `**${row.source_name}:** ${row.project_count} projects, ${row.session_count} sessions, ${row.message_count} messages\n`
    }

    output += `\n## Top Projects\n\n`
    for (const row of topProjects.rows) {
      output += `- **${row.name}:** ${row.session_count} sessions, ${row.message_count} messages\n`
    }

    return { content: [{ type: 'text', text: output }] }
  }
)

// Get session transcript
server.tool(
  'getSessionTranscript',
  `Get the full transcript of a Claude Code or Cursor session by ID or title search.

By default, returns a **summary** of the session to avoid token overflow.
Use \`full: true\` to get the complete transcript (warning: may be very large).

**Search behavior:**
- First tries exact match on session external_id
- Falls back to ILIKE search on session title

**Output modes:**
- Default (summary): Session metadata + AI-generated summary (~1-3k chars)
- Full transcript: All messages with timestamps and roles (can be 50k+ chars)`,
  {
    searchTerm: z.string().describe('Session external_id or title search term'),
    full: z.boolean().optional().describe('Return full transcript instead of summary (default: false, returns summary)'),
  },
  async (params) => {
    // Try to find session by external_id first, then by title search
    const sessionResult = await query<{
      id: number
      external_id: string
      title: string
      project_path: string
      source_name: string
      started_at: Date
      message_count: number
      summary: string | null
    }>(
      `SELECT s.id, s.external_id, s.title, p.path as project_path,
              src.name as source_name, s.started_at, s.message_count, s.summary
       FROM sessions s
       JOIN projects p ON s.project_id = p.id
       JOIN sources src ON p.source_id = src.id
       WHERE (s.external_id = $1 OR s.title ILIKE $2)
         AND s.deleted_at IS NULL
       ORDER BY s.started_at DESC
       LIMIT 1`,
      [params.searchTerm, `%${params.searchTerm}%`]
    )

    if (sessionResult.rows.length === 0) {
      return {
        content: [{ type: 'text', text: `No session found matching: ${params.searchTerm}` }],
        isError: true,
      }
    }

    const session = sessionResult.rows[0]

    // Return summary by default (unless full transcript requested)
    if (!params.full) {
      let output = `# ${session.title} (Summary)\n\n`
      output += `**Session ID:** ${session.id}\n`
      output += `**External ID:** ${session.external_id}\n`
      output += `**Source:** ${session.source_name}\n`
      output += `**Project:** ${session.project_path}\n`
      output += `**Started:** ${session.started_at.toLocaleString()}\n`
      output += `**Messages:** ${session.message_count}\n\n`
      output += `---\n\n`
      output += `## Summary\n\n`

      if (session.summary) {
        output += session.summary
      } else {
        output += `*Summary not yet generated for this session. Use \`getSession\` with \`messageLimit\` as a fallback.*`
      }

      return { content: [{ type: 'text', text: output }] }
    }

    // Get all messages for this session
    const messagesResult = await query<{
      sequence_num: number
      role: string
      content_text: string | null
      content_json: any | null
      timestamp: Date
      model: string | null
      tool_name: string | null
    }>(
      `SELECT sequence_num, role, content_text, content_json, timestamp, model, tool_name
       FROM messages
       WHERE session_id = $1
       ORDER BY sequence_num`,
      [session.id]
    )

    // Format transcript
    let transcript = `# ${session.title}\n\n`
    transcript += `**Session ID:** ${session.external_id}\n`
    transcript += `**Source:** ${session.source_name}\n`
    transcript += `**Project:** ${session.project_path}\n`
    transcript += `**Started:** ${session.started_at.toLocaleString()}\n`
    transcript += `**Messages:** ${session.message_count}\n\n`
    transcript += `---\n\n`

    for (const msg of messagesResult.rows) {
      const timestamp = msg.timestamp.toLocaleTimeString()
      const model = msg.model ? ` [${msg.model}]` : ''
      const tool = msg.tool_name ? ` (tool: ${msg.tool_name})` : ''

      transcript += `## [${timestamp}] ${msg.role.toUpperCase()}${model}${tool}\n\n`

      if (msg.content_text) {
        transcript += `${msg.content_text}\n\n`
      } else if (msg.content_json) {
        transcript += `*[JSON content]*\n\n`
      }
    }

    return { content: [{ type: 'text', text: transcript }] }
  }
)

// Start server
const transport = new StdioServerTransport()
await server.connect(transport)

// Cleanup on exit
process.on('SIGINT', async () => {
  await closePool()
  process.exit(0)
})
