/**
 * Backfill the sessions.is_automated column on existing rows.
 *
 * Two signals, matching how new rows are classified at sync time:
 *   1. classifyAutomated() — persona-prompt prefixes on the session title's
 *      first line (Slack monitoring, curiosity curation, MCP health checks,
 *      huddle transcripts). Applied per-row in JS so the regexes stay the
 *      single source of truth shared with src/embeddings/classify.ts.
 *   2. Recurring fingerprint — the same first line appearing 20+ times is a
 *      cron-driven automated run (mirrors scripts/mark-warmups.ts step 4).
 *
 * Read CLAUDE.md guardrails: this is NOT run against the live DB as part of the
 * ticket. Run manually once the migration is applied:
 *   pnpm tsx scripts/backfill-automated.ts
 */

import { query } from '../src/db/postgres.js'
import { classifyAutomated } from '../src/embeddings/classify.js'

const run = async () => {
  console.log('=== Backfilling sessions.is_automated ===\n')

  console.log('Step 1: Persona-prompt titles (classifyAutomated)...')
  const candidates = await query<{ id: number; title: string | null }>(
    `SELECT id, title FROM sessions
     WHERE deleted_at IS NULL AND is_automated = false AND title IS NOT NULL`
  )

  const automatedIds = candidates.rows
    .filter((row) => classifyAutomated(row.title) !== null)
    .map((row) => row.id)

  let personaMarked = 0
  const chunkSize = 1000
  for (let i = 0; i < automatedIds.length; i += chunkSize) {
    const chunk = automatedIds.slice(i, i + chunkSize)
    const result = await query(
      `UPDATE sessions SET is_automated = true WHERE id = ANY($1::int[])`,
      [chunk]
    )
    personaMarked += result.rowCount ?? 0
  }
  console.log(`Marked ${personaMarked} sessions by persona prompt`)

  console.log('\nStep 2: Recurring automated sessions (same first line 20+ times)...')
  const recurring = await query(
    `UPDATE sessions
     SET is_automated = true
     WHERE is_automated = false
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
  console.log(`Marked ${recurring.rowCount} recurring automated sessions`)

  const stats = await query<{ automated: string; interactive: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE is_automated = true) AS automated,
       COUNT(*) FILTER (WHERE is_automated = false) AS interactive
     FROM sessions WHERE deleted_at IS NULL`
  )
  console.log(`\n=== Summary ===`)
  console.log(`Automated: ${stats.rows[0]?.automated}`)
  console.log(`Interactive: ${stats.rows[0]?.interactive}`)
  console.log('Done!')
}

run().catch(console.error)
