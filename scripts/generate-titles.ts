/**
 * Generate titles for sessions whose summary is their own transcript.
 *
 * New sessions get one when they are summarized (batch.ts). This fills in the
 * ones summarized before generated_title existed. It is resumable: it only
 * selects rows still lacking a title, so a stopped run picks up where it left
 * off, and a row the model fails on is retried on the next run.
 *
 * Run scripts/backfill-titles.ts --apply first. A claude_code session still
 * holding its old first-message fragment in `title` resolves to that fragment,
 * which outranks any generated title.
 *
 * Not run automatically:
 *   pnpm tsx scripts/generate-titles.ts                       # count only
 *   pnpm tsx scripts/generate-titles.ts --execute [--limit N]
 */

import { query, closePool } from '../src/db/postgres.js'
import { generateTitle } from '../src/embeddings/summarize.js'
import { VERBATIM_TRANSCRIPT_PATTERN } from '../src/embeddings/verbatim.js'
import { notWarmup } from '../src/mcp/title.js'
import { aiHold, AI_HOLD_NOTICE } from '../src/sync/sync-control.js'

const PAGE = 50
// generateTitle returns null for a shut GPU gate as well as for a bad title, so
// a run of nulls means the gate, not the sessions. Stop and resume later.
const MAX_CONSECUTIVE_FAILURES = 10

const NEEDS_TITLE = `
  FROM sessions s
  WHERE s.deleted_at IS NULL AND ${notWarmup('s')}
    AND s.generated_title IS NULL
    AND (s.title IS NULL OR btrim(s.title) = '')
    AND s.summary ~ '${VERBATIM_TRANSCRIPT_PATTERN}'`

const run = async () => {
  const args = process.argv.slice(2)
  const execute = args.includes('--execute')
  const limitAt = args.indexOf('--limit')
  const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Number.POSITIVE_INFINITY

  const { rows } = await query<{ n: string }>(`SELECT COUNT(*) AS n ${NEEDS_TITLE}`)
  console.log(`Sessions with a verbatim summary and no generated title: ${rows[0].n}`)
  if (!execute) {
    console.log('Count only. Re-run with --execute to generate them.')
    return
  }

  let afterId = 0
  let done = 0
  let failedInARow = 0
  while (done < limit) {
    const hold = await aiHold()
    if (hold) {
      console.log(AI_HOLD_NOTICE[hold])
      return
    }
    const page = await query<{ id: number; summary: string }>(
      `SELECT s.id, s.summary ${NEEDS_TITLE} AND s.id > $1 ORDER BY s.id LIMIT $2`,
      [afterId, PAGE],
    )
    if (page.rows.length === 0) break
    for (const row of page.rows) {
      if (done >= limit) break
      afterId = row.id
      done++
      const title = await generateTitle(row.summary)
      if (title === null) {
        failedInARow++
        if (failedInARow >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`${failedInARow} failures in a row; stopping at session ${row.id}. Re-run to resume.`)
          return
        }
        continue
      }
      failedInARow = 0
      await query(`UPDATE sessions SET generated_title = $1 WHERE id = $2 AND generated_title IS NULL`, [
        title,
        row.id,
      ])
    }
    console.log(`${done} sessions attempted (through id ${afterId})`)
  }
}

run()
  .then(() => closePool())
  .catch(async (e) => {
    console.error(e)
    await closePool()
    process.exit(1)
  })
