/**
 * Backfill sessions.title for sessions whose title is command-XML garbage
 * (starts with <command-name>, <command-message>, <local-command-...>,
 * <system-reminder>, ...).
 *
 * Recomputes each title with the same rule sync now uses for new sessions
 * (src/parsers/session-title.ts): first human-typed user message, with command
 * XML and system-reminder wrappers stripped; tool_result user rows skipped.
 * Sessions where no human text exists anywhere keep their existing title
 * (the derivation falls back to the first message, i.e. what's already there).
 *
 * Read CLAUDE.md guardrails: this is NOT run against the live DB as part of
 * the ticket. Run manually once the branch is deployed:
 *   pnpm tsx scripts/backfill-session-titles.ts
 */

import { query, closePool } from '../src/db/postgres.js'
import { deriveSessionTitle, COMMAND_TITLE_PREFIXES } from '../src/parsers/session-title.js'

// Early messages are enough — the title comes from the first human text.
const MESSAGE_SCAN_LIMIT = 100

const run = async () => {
  console.log('=== Backfilling command-XML session titles ===\n')

  const likeClauses = COMMAND_TITLE_PREFIXES.map((_, i) => `title LIKE $${i + 1}`).join(' OR ')
  const likeValues = COMMAND_TITLE_PREFIXES.map((prefix) => `${prefix}%`)

  const candidates = await query<{ id: number; title: string }>(
    `SELECT id, title FROM sessions
     WHERE deleted_at IS NULL AND (${likeClauses})
     ORDER BY id`,
    likeValues
  )
  console.log(`Found ${candidates.rows.length} sessions with command-XML titles`)

  let updated = 0
  let unchanged = 0

  for (const session of candidates.rows) {
    const messages = await query<{
      role: string
      content_text: string | null
      is_tool_result: boolean
    }>(
      `SELECT role, content_text,
              (jsonb_typeof(content_json->'content') = 'array'
               AND content_json->'content' @> '[{"type": "tool_result"}]'::jsonb) AS is_tool_result
       FROM messages
       WHERE session_id = $1
       ORDER BY sequence_num ASC
       LIMIT $2`,
      [session.id, MESSAGE_SCAN_LIMIT]
    )

    const newTitle = deriveSessionTitle(
      messages.rows.map((m) => ({
        role: m.role,
        contentText: m.content_text,
        isToolResult: m.is_tool_result ?? false,
      }))
    )

    if (!newTitle || newTitle === session.title) {
      unchanged++
      continue
    }

    await query(`UPDATE sessions SET title = $1 WHERE id = $2`, [newTitle, session.id])
    updated++
    if (updated % 100 === 0) console.log(`Updated ${updated} titles...`)
  }

  console.log(`\n=== Summary ===`)
  console.log(`Updated:   ${updated}`)
  console.log(`Unchanged: ${unchanged} (no human text found — kept existing title)`)
  console.log('Done!')
}

run()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => closePool())
