/**
 * Clear the fabricated session titles (issue #95).
 *
 * `sessions.title` was written exactly once, at sync, as the first 200
 * characters of the session's first message. Nothing ever re-derived it, so a
 * conversation that opened with a persona prompt or a task brief was titled
 * with that brief permanently — including after it had been summarized.
 *
 * Claude Code transcripts carry no title field, so every claude_code title in
 * the database is a message fragment and none of them is recoverable as a real
 * title. This nulls them. The read path (src/mcp/title.ts) then derives a title
 * from the summary where one exists, and shows none where it does not, instead
 * of presenting an instruction fragment as a topic.
 *
 * Other sources are left alone: Android threads supply genuine titles (short,
 * source-authored) and are not affected.
 *
 * This also clears the fragments out of the two title ILIKE surfaces
 * (getSession term resolution, /api/sessions?q=), which were substring-matching
 * message bodies while claiming to match titles.
 *
 * Not run automatically. Run manually:
 *   pnpm tsx scripts/backfill-titles.ts          # report only
 *   pnpm tsx scripts/backfill-titles.ts --apply  # write
 */

import { query } from '../src/db/postgres.js'

const FABRICATED = `
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  JOIN sources src ON src.id = p.source_id
  WHERE src.name = 'claude_code' AND s.title IS NOT NULL`

const run = async () => {
  const apply = process.argv.includes('--apply')

  const before = await query<{ total: string; cut_at_200: string; summarized: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE LENGTH(s.title) = 200) AS cut_at_200,
            COUNT(*) FILTER (WHERE s.summary IS NOT NULL) AS summarized
     ${FABRICATED}`
  )
  const { total, cut_at_200, summarized } = before.rows[0]

  console.log('=== Fabricated session titles (#95) ===\n')
  console.log(`claude_code sessions with a stored title : ${total}`)
  console.log(`  cut mid-word at exactly 200 characters : ${cut_at_200}`)
  console.log(`  already summarized, so a real title is`)
  console.log(`  available immediately once this clears : ${summarized}`)

  if (!apply) {
    console.log('\nReport only. Re-run with --apply to clear them.')
    return
  }

  const result = await query(
    `UPDATE sessions SET title = NULL
     WHERE id IN (SELECT s.id ${FABRICATED})`
  )
  console.log(`\nCleared ${result.rowCount} title(s).`)
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
