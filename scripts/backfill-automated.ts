/**
 * Backfill the sessions.is_automated column on existing rows.
 *
 * Two signals, matching how new rows are classified at sync time:
 *   1. classifyAutomated() — persona-prompt prefixes on the first line of the
 *      text sync classifies: the first user-role message for sources synced through
 *      syncSession (claude_code and codex),
 *      which have no title since #95, and the title for every other source.
 *      Applied per-row in JS so the regexes stay the single source of truth
 *      shared with src/embeddings/classify.ts.
 *   2. Recurring fingerprint — the same first line appearing 20+ times is a
 *      cron-driven automated run (mirrors scripts/mark-warmups.ts step 4).
 *
 * Read CLAUDE.md guardrails: this is NOT run against the live DB as part of the
 * ticket. Run manually once the migration is applied:
 *   pnpm tsx scripts/backfill-automated.ts
 */

import { query } from '../src/db/postgres.js'
import { classifyAutomated } from '../src/embeddings/classify.js'

// Sources whose sessions carry no title and are classified by their opening
// prompt at sync time: both go through syncSession in src/sync/claude-code.ts.
// Codex joined it after this script was written, so Codex Slack-monitor and
// curiosity-curator runs synced before the classifier existed were never
// flagged. Not the orchestrator's default source list, which only happens to
// match: that one says what to sync, this one how a source is classified.
const FIRST_PROMPT_SOURCES = ['claude_code', 'codex']

const run = async () => {
  console.log('=== Backfilling sessions.is_automated ===\n')

  console.log('Step 1: Persona-prompt titles (classifyAutomated)...')
  const candidates = await query<{ id: number; classified_text: string | null }>(
    `SELECT s.id,
            CASE WHEN src.name = ANY($1::text[]) THEN m.content_text ELSE s.title END AS classified_text
     FROM sessions s
     JOIN projects p ON p.id = s.project_id
     JOIN sources src ON src.id = p.source_id
     LEFT JOIN LATERAL (
       SELECT content_text FROM messages
       WHERE src.name = ANY($1::text[]) AND session_id = s.id AND role = 'user'
       ORDER BY sequence_num NULLS FIRST, timestamp, id
       LIMIT 1
     ) m ON true
     WHERE s.deleted_at IS NULL AND s.is_automated = false`,
    [FIRST_PROMPT_SOURCES]
  )

  const automatedIds = candidates.rows
    .filter((row) => classifyAutomated(row.classified_text) !== null)
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
