/**
 * Centroid computation service
 * Computes average embeddings for sessions and projects using streaming pagination
 */

import { query } from '../db/postgres.js'
import { getCollection } from '../db/chroma.js'
import { config } from '../config.js'
import { normalizeVector } from '../utils/vector-math.js'

const BGE_DIMENSIONS = 1024 // BGE-M3 model dimensions
const BATCH_SIZE = 100 // Fetch embeddings in batches to avoid memory limits

/**
 * Compute centroid for a single session
 * Returns the average of all message embeddings for the session
 */
export const computeSessionCentroid = async (
  sessionId: number
): Promise<{ centroid: number[]; count: number } | null> => {
  // Get total message count for this session
  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM messages m
     JOIN embeddings e ON m.id = e.message_id
     WHERE m.session_id = $1
       AND e.chroma_collection = $2
       AND m.content_text IS NOT NULL
       AND LENGTH(m.content_text) > 10`,
    [sessionId, config.chroma.collections.messages]
  )

  const totalCount = countResult.rows[0]?.count ?? 0
  if (totalCount === 0) {
    return null // No messages with embeddings
  }

  // Accumulate vector sum using streaming pagination
  const sum = new Array(BGE_DIMENSIONS).fill(0)
  let processedCount = 0
  let lastMessageId = 0

  const collection = await getCollection(config.chroma.collections.messages)

  while (processedCount < totalCount) {
    // Fetch next batch of message IDs
    const messageResult = await query<{ id: number; chroma_id: string }>(
      `SELECT m.id, e.chroma_id
       FROM messages m
       JOIN embeddings e ON m.id = e.message_id
       WHERE m.session_id = $1
         AND e.chroma_collection = $2
         AND m.id > $3
       ORDER BY m.id
       LIMIT $4`,
      [sessionId, config.chroma.collections.messages, lastMessageId, BATCH_SIZE]
    )

    if (messageResult.rows.length === 0) break

    // Fetch embeddings from Chroma
    const chromaIds = messageResult.rows.map((row) => row.chroma_id)
    const chromaResult = await collection.get({
      ids: chromaIds,
      include: ['embeddings'],
    })

    // Accumulate vectors
    if (chromaResult.embeddings) {
      for (const embedding of chromaResult.embeddings) {
        if (embedding && embedding.length === BGE_DIMENSIONS) {
          for (let i = 0; i < BGE_DIMENSIONS; i++) {
            sum[i] += embedding[i]
          }
          processedCount++
        }
      }
    }

    lastMessageId = messageResult.rows[messageResult.rows.length - 1].id
  }

  if (processedCount === 0) {
    return null
  }

  // Compute mean and normalize
  const mean = sum.map((s) => s / processedCount)
  const centroid = normalizeVector(mean)

  return { centroid, count: processedCount }
}

/**
 * Compute centroid for a single project
 * Returns the average of all message embeddings across all sessions in the project
 */
export const computeProjectCentroid = async (
  projectId: number
): Promise<{ centroid: number[]; count: number } | null> => {
  // Get total message count for this project
  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM messages m
     JOIN sessions s ON m.session_id = s.id
     JOIN embeddings e ON m.id = e.message_id
     WHERE s.project_id = $1
       AND e.chroma_collection = $2
       AND m.content_text IS NOT NULL
       AND LENGTH(m.content_text) > 10`,
    [projectId, config.chroma.collections.messages]
  )

  const totalCount = countResult.rows[0]?.count ?? 0
  if (totalCount === 0) {
    return null // No messages with embeddings
  }

  // Accumulate vector sum using streaming pagination
  const sum = new Array(BGE_DIMENSIONS).fill(0)
  let processedCount = 0
  let lastMessageId = 0

  const collection = await getCollection(config.chroma.collections.messages)

  while (processedCount < totalCount) {
    // Fetch next batch of message IDs
    const messageResult = await query<{ id: number; chroma_id: string }>(
      `SELECT m.id, e.chroma_id
       FROM messages m
       JOIN sessions s ON m.session_id = s.id
       JOIN embeddings e ON m.id = e.message_id
       WHERE s.project_id = $1
         AND e.chroma_collection = $2
         AND m.id > $3
       ORDER BY m.id
       LIMIT $4`,
      [projectId, config.chroma.collections.messages, lastMessageId, BATCH_SIZE]
    )

    if (messageResult.rows.length === 0) break

    // Fetch embeddings from Chroma
    const chromaIds = messageResult.rows.map((row) => row.chroma_id)
    const chromaResult = await collection.get({
      ids: chromaIds,
      include: ['embeddings'],
    })

    // Accumulate vectors
    if (chromaResult.embeddings) {
      for (const embedding of chromaResult.embeddings) {
        if (embedding && embedding.length === BGE_DIMENSIONS) {
          for (let i = 0; i < BGE_DIMENSIONS; i++) {
            sum[i] += embedding[i]
          }
          processedCount++
        }
      }
    }

    lastMessageId = messageResult.rows[messageResult.rows.length - 1].id
  }

  if (processedCount === 0) {
    return null
  }

  // Compute mean and normalize
  const mean = sum.map((s) => s / processedCount)
  const centroid = normalizeVector(mean)

  return { centroid, count: processedCount }
}

/**
 * Compute and store centroid for a session
 */
export const updateSessionCentroid = async (sessionId: number): Promise<void> => {
  const result = await computeSessionCentroid(sessionId)

  if (result) {
    const centroidJson = JSON.stringify(result.centroid)
    await query(
      `UPDATE sessions
       SET centroid_vector = $1,
           centroid_message_count = $2,
           centroid_computed_at = NOW()
       WHERE id = $3`,
      [centroidJson, result.count, sessionId]
    )
  }
}

/**
 * Compute and store centroid for a project
 */
export const updateProjectCentroid = async (projectId: number): Promise<void> => {
  const result = await computeProjectCentroid(projectId)

  if (result) {
    const centroidJson = JSON.stringify(result.centroid)
    await query(
      `UPDATE projects
       SET centroid_vector = $1,
           centroid_message_count = $2,
           centroid_computed_at = NOW()
       WHERE id = $3`,
      [centroidJson, result.count, projectId]
    )
  }
}

/**
 * Compute centroids for all sessions
 */
export const computeAllSessionCentroids = async (): Promise<void> => {
  // Get all sessions that have messages with embeddings
  const sessionsResult = await query<{ id: number; title: string }>(
    `SELECT DISTINCT s.id, s.title
     FROM sessions s
     JOIN messages m ON s.id = m.session_id
     JOIN embeddings e ON m.id = e.message_id
     WHERE e.chroma_collection = $1
       AND s.title != 'Warmup'
     ORDER BY s.id`,
    [config.chroma.collections.messages]
  )

  console.log(`Computing centroids for ${sessionsResult.rows.length} sessions...`)

  let processed = 0
  for (const session of sessionsResult.rows) {
    try {
      await updateSessionCentroid(session.id)
      processed++
      if (processed % 10 === 0) {
        console.log(`Processed ${processed}/${sessionsResult.rows.length} sessions`)
      }
    } catch (error) {
      console.error(`Failed to compute centroid for session ${session.id}:`, error)
    }
  }

  console.log(`Completed! Computed ${processed} session centroids`)
}

/**
 * Compute centroids for all projects
 */
export const computeAllProjectCentroids = async (): Promise<void> => {
  // Get all projects that have messages with embeddings
  const projectsResult = await query<{ id: number; name: string }>(
    `SELECT DISTINCT p.id, p.name
     FROM projects p
     JOIN sessions s ON p.id = s.project_id
     JOIN messages m ON s.id = m.session_id
     JOIN embeddings e ON m.id = e.message_id
     WHERE e.chroma_collection = $1
     ORDER BY p.id`,
    [config.chroma.collections.messages]
  )

  console.log(`Computing centroids for ${projectsResult.rows.length} projects...`)

  let processed = 0
  for (const project of projectsResult.rows) {
    try {
      await updateProjectCentroid(project.id)
      processed++
      if (processed % 5 === 0) {
        console.log(`Processed ${processed}/${projectsResult.rows.length} projects`)
      }
    } catch (error) {
      console.error(`Failed to compute centroid for project ${project.id}:`, error)
    }
  }

  console.log(`Completed! Computed ${processed} project centroids`)
}
