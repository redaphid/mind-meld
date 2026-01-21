/**
 * Mark warmup sessions using simple rule-based detection
 *
 * Rules (in order):
 * 1. Title contains "warmup" (case insensitive) = warmup
 * 2. Message count <= 3 = warmup (short sessions rarely have value)
 * 3. Empty sessions (0 messages) older than 1 day = warmup
 *
 * Note: We tried semantic similarity (cosine distance from warmup centroid)
 * but it performed worse than these simple rules:
 * - Missed 1,271 sessions with "Warmup" in the title
 * - Only caught 2 additional warmups that message count wouldn't catch
 * - Required Chroma/embeddings infrastructure
 */

import { query } from '../src/db/postgres.js'

const SHORT_SESSION_THRESHOLD = 3

const run = async () => {
  console.log('=== Marking Warmup Sessions (Rule-Based) ===\n')

  // Step 1: Mark sessions with "warmup" in title
  console.log('Step 1: Marking sessions with "warmup" in title...')
  const titleResult = await query(
    `UPDATE sessions
     SET is_warmup = true
     WHERE LOWER(title) LIKE '%warmup%'
       AND is_warmup = false
       AND deleted_at IS NULL
     RETURNING id`
  )
  console.log(`Marked ${titleResult.rowCount} sessions by title`)

  // Step 2: Mark short sessions (≤3 messages)
  console.log('\nStep 2: Marking short sessions (≤3 messages)...')
  const shortResult = await query(
    `UPDATE sessions
     SET is_warmup = true
     WHERE message_count <= $1
       AND message_count > 0
       AND is_warmup = false
       AND deleted_at IS NULL
     RETURNING id`,
    [SHORT_SESSION_THRESHOLD]
  )
  console.log(`Marked ${shortResult.rowCount} short sessions`)

  // Step 3: Mark empty sessions older than 1 day
  console.log('\nStep 3: Marking empty sessions >1 day old...')
  const emptyResult = await query(
    `UPDATE sessions
     SET is_warmup = true
     WHERE message_count = 0
       AND is_warmup = false
       AND deleted_at IS NULL
       AND started_at < now() - interval '1 day'
     RETURNING id`
  )
  console.log(`Marked ${emptyResult.rowCount} empty sessions`)

  // Step 4: Soft-delete all warmups
  console.log('\nStep 4: Soft-deleting warmups...')
  const deleteResult = await query(
    `UPDATE sessions
     SET deleted_at = now()
     WHERE is_warmup = true AND deleted_at IS NULL
     RETURNING id`
  )
  console.log(`Soft-deleted ${deleteResult.rowCount} warmup sessions`)

  // Summary
  const stats = await query<{ active: number; deleted: number; short_active: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE deleted_at IS NULL) as active,
       COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) as deleted,
       COUNT(*) FILTER (WHERE deleted_at IS NULL AND message_count <= 3) as short_active
     FROM sessions`
  )
  console.log(`\n=== Summary ===`)
  console.log(`Active sessions: ${stats.rows[0]?.active}`)
  console.log(`Deleted sessions: ${stats.rows[0]?.deleted}`)
  console.log(`Short active (≤3 msgs): ${stats.rows[0]?.short_active}`)
  console.log('Done!')
}

run().catch(console.error)
