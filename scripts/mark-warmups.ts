/**
 * QUARANTINED 2026-08-26 - NOT RUN AUTOMATICALLY. Read this before running it.
 *
 * The `warmup-filter` service that ran this on a 6h loop has been removed. It
 * had never once run successfully: the container was created 2026-08-08 and
 * crash-looped on ERR_MODULE_NOT_FOUND for its entire life, because
 * .dockerignore excludes `scripts` wholesale (issue #64 privacy scrub) and this
 * file is the container's own entrypoint.
 *
 * That outage cost nothing, and fixing it would have caused real harm. Nothing
 * reads the `is_warmup` column this script writes - the application excludes
 * warmups at query time via notWarmup() in src/mcp/title.js, which is just
 * `title IS DISTINCT FROM 'Warmup'` and needs no batch job. So the only
 * effective action this script has is step 5, which SOFT-DELETES, and
 * deleted_at IS NULL gates every search, browse and session lookup.
 *
 * Measured against the live corpus on 2026-08-26, a first successful run would
 * have soft-deleted 971 of 2,833 active sessions (34%):
 *   - step 2 (<=3 messages): 947 sessions, including 685 of 1,134 `phone`
 *     captures (Slack threads and Gmail) and effectively the whole Vikunja
 *     notes corpus - House Chores 9/9, Nudges 6/6, Groceries 14/15,
 *     "Agents only" 33/47, Agent Queue 8/18.
 *   - step 4 does not do what it claims. It says "same first line 20+ times =
 *     cron job", but the only group meeting that threshold is sessions with an
 *     EMPTY-STRING title, one of which has 1,845 messages. The 577 NULL-title
 *     sessions escape only by accident of SQL `IN` NULL semantics.
 *   - step 1, the rule this service is actually named for, would have matched
 *     exactly 1 session. The warmup phenomenon it was built for is gone.
 *
 * The heuristic was written 2026-04-24, when the corpus was only Claude Code
 * transcripts and "<=3 messages" really did mean an aborted session. mindmeld
 * then gained two sources whose records are legitimately 1-3 messages: `phone`
 * (2026-08-02) and the Vikunja notes sync (2026-08-07). Its premise expired.
 *
 * If you want warmup filtering back, fix steps 2 and 4 first - scope them to
 * coding sessions, and do not treat a short note as worthless.
 *
 * Original rules (in order):
 * 1. Title contains "warmup" (case insensitive) = warmup
 * 2. Message count <= 3 = warmup (short sessions rarely have value)
 * 3. Empty sessions (0 messages) older than 1 day = warmup
 * 4. Recurring sessions: same first line appears 20+ times = automated cron job
 *
 * Note: We tried semantic similarity (cosine distance from warmup centroid)
 * but it performed worse than these simple rules:
 * - Missed 1,271 sessions with "Warmup" in the title
 * - Only caught 2 additional warmups that message count wouldn't catch
 * - Required Chroma/embeddings infrastructure
 */

import { query } from '../src/db/postgres.js'

const SHORT_SESSION_THRESHOLD = 3

const CONFIRM = "I_HAVE_READ_THE_2026_08_26_WARMUP_ANALYSIS"

const run = async () => {
  if (process.env.MARK_WARMUPS_CONFIRM !== CONFIRM) {
    console.error(
      `Refusing to run: this soft-deletes sessions and its heuristics are known ` +
      `stale (see the header of this file). Set MARK_WARMUPS_CONFIRM=${CONFIRM} ` +
      `to override.`
    )
    process.exitCode = 1
    return
  }
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

  // Step 4: Mark recurring automated sessions (same first line 20+ times = cron job)
  // Fingerprints the first line of the title — catches repeated prompt templates
  // without being specific to any tool or machine.
  console.log('\nStep 4: Marking recurring automated sessions...')
  const recurringResult = await query(
    `UPDATE sessions
     SET is_warmup = true
     WHERE is_warmup = false
       AND deleted_at IS NULL
       AND SPLIT_PART(title, E'\n', 1) IN (
         SELECT SPLIT_PART(title, E'\n', 1)
         FROM sessions
         WHERE deleted_at IS NULL
         GROUP BY SPLIT_PART(title, E'\n', 1)
         HAVING COUNT(*) >= 20
       )
     RETURNING id`
  )
  console.log(`Marked ${recurringResult.rowCount} recurring automated sessions`)

  // Step 5: Soft-delete all warmups
  console.log('\nStep 5: Soft-deleting warmups...')
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
