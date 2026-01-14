/**
 * Mark warmup sessions using semantic similarity
 *
 * Uses stored warmup centroid (or computes once if missing)
 * to find and soft-delete warmup sessions
 */

import { ChromaClient } from 'chromadb'
import { query } from '../src/db/postgres.js'
import { normalizeVector, cosineSimilarity } from '../src/utils/vector-math.js'

const WARMUP_DISTANCE_THRESHOLD = 0.25
const BATCH_SIZE = 500

const client = new ChromaClient({ path: 'http://localhost:8001' })

const getOrComputeWarmupCentroid = async (collection: Awaited<ReturnType<typeof client.getCollection>>): Promise<number[]> => {
  // Check for stored centroid (value is JSONB, returned as object)
  const stored = await query<{ value: number[] }>(
    `SELECT value FROM system_config WHERE key = 'warmup_centroid'`
  )

  if (stored.rows[0]?.value) {
    const centroid = stored.rows[0].value
    console.log(`Using stored warmup centroid (${centroid.length} dimensions)`)
    return centroid
  }

  // Compute from known warmups
  console.log('No stored centroid found, computing from known warmups...')
  const knownWarmups = await query<{ id: number }>(
    `SELECT id FROM sessions WHERE title = 'Warmup' LIMIT 100`
  )
  console.log(`Found ${knownWarmups.rows.length} sessions titled "Warmup"`)

  const warmupIds = knownWarmups.rows.map(r => `session-${r.id}`)
  const warmupEmbeddings = await collection.get({
    ids: warmupIds,
    include: ['embeddings']
  })

  const validEmbeddings = warmupEmbeddings.embeddings?.filter(e => e && e.length > 0) ?? []
  if (validEmbeddings.length === 0) {
    throw new Error('No warmup embeddings found - cannot compute centroid')
  }

  const dims = validEmbeddings[0].length
  const sum = new Array(dims).fill(0)
  for (const emb of validEmbeddings) {
    for (let i = 0; i < dims; i++) {
      sum[i] += emb[i]
    }
  }
  const centroid = normalizeVector(sum.map(s => s / validEmbeddings.length))

  // Store for future use
  await query(
    `INSERT INTO system_config (key, value, updated_at)
     VALUES ('warmup_centroid', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify(centroid)]
  )
  console.log(`Computed and stored centroid (${dims} dimensions)`)

  return centroid
}

const run = async () => {
  console.log('=== Marking Warmup Sessions ===\n')

  const collection = await client.getCollection({ name: 'convo-sessions' })

  // Step 1: Get or load warmup centroid
  console.log('Step 1: Loading warmup centroid...')
  const warmupCentroid = await getOrComputeWarmupCentroid(collection)

  // Step 2: Find sessions not yet checked
  console.log('\nStep 2: Finding sessions to check...')

  // Only check sessions that have embeddings but no warmup_distance yet
  const uncheckedResult = await query<{ count: number }>(
    `SELECT COUNT(*) as count FROM sessions s
     WHERE s.warmup_distance IS NULL
       AND s.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM embeddings e
         WHERE e.chroma_collection = 'convo-sessions'
           AND e.chroma_id = 'session-' || s.id::text
       )`
  )
  const uncheckedCount = Number(uncheckedResult.rows[0]?.count ?? 0)
  console.log(`Found ${uncheckedCount} sessions to check`)

  if (uncheckedCount === 0) {
    console.log('No new sessions to check')
  } else {
    // Get all unchecked session IDs
    const uncheckedSessions = await query<{ id: number }>(
      `SELECT s.id FROM sessions s
       WHERE s.warmup_distance IS NULL
         AND s.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM embeddings e
           WHERE e.chroma_collection = 'convo-sessions'
             AND e.chroma_id = 'session-' || s.id::text
         )`
    )

    // Get embeddings from Chroma
    const sessionIds = uncheckedSessions.rows.map(r => `session-${r.id}`)
    console.log(`Fetching ${sessionIds.length} embeddings from Chroma...`)

    const chromaData = await collection.get({
      ids: sessionIds,
      include: ['embeddings']
    })

    // Compute distances and prepare updates
    const updates: Array<{ sessionId: number; distance: number; isWarmup: boolean }> = []

    for (let i = 0; i < chromaData.ids.length; i++) {
      const chromaId = chromaData.ids[i]
      const embedding = chromaData.embeddings?.[i]

      if (!embedding) continue

      const sessionId = parseInt(chromaId.replace('session-', ''), 10)
      const similarity = cosineSimilarity(embedding, warmupCentroid)
      const distance = 1 - similarity

      updates.push({
        sessionId,
        distance,
        isWarmup: distance < WARMUP_DISTANCE_THRESHOLD
      })
    }

    // Batch update
    console.log(`Updating ${updates.length} sessions...`)
    let markedWarmup = 0

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE)
      const values = batch.map((u, idx) =>
        `($${idx * 3 + 1}::int, $${idx * 3 + 2}::real, $${idx * 3 + 3}::boolean)`
      ).join(', ')
      const params = batch.flatMap(u => [u.sessionId, u.distance, u.isWarmup])

      await query(
        `UPDATE sessions AS s SET
           warmup_distance = v.distance,
           is_warmup = v.is_warmup
         FROM (VALUES ${values}) AS v(id, distance, is_warmup)
         WHERE s.id = v.id`,
        params
      )

      markedWarmup += batch.filter(u => u.isWarmup).length
    }

    console.log(`Marked ${markedWarmup} new warmups`)
  }

  // Step 3: Soft-delete warmups
  console.log('\nStep 3: Soft-deleting warmups...')
  const deleteResult = await query(
    `UPDATE sessions
     SET deleted_at = now()
     WHERE is_warmup = true AND deleted_at IS NULL
     RETURNING id`
  )
  console.log(`Soft-deleted ${deleteResult.rowCount} warmup sessions`)

  // Step 4: Clean up empty sessions >1 day old
  console.log('\nStep 4: Cleaning up empty sessions >1 day old...')
  const emptyResult = await query(
    `UPDATE sessions
     SET is_warmup = true, deleted_at = now()
     WHERE message_count = 0
       AND deleted_at IS NULL
       AND started_at < now() - interval '1 day'
     RETURNING id`
  )
  console.log(`Soft-deleted ${emptyResult.rowCount} empty sessions`)

  // Summary
  const stats = await query<{ active: number; deleted: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE deleted_at IS NULL) as active,
       COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) as deleted
     FROM sessions`
  )
  console.log(`\n=== Summary ===`)
  console.log(`Active sessions: ${stats.rows[0]?.active}`)
  console.log(`Deleted sessions: ${stats.rows[0]?.deleted}`)
  console.log('Done!')
}

run().catch(console.error)
