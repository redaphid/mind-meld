/**
 * Bring sessions.is_automated into agreement with classifyAutomated.
 *
 *   pnpm tsx scripts/backfill-automated.ts           # dry run: what would change
 *   pnpm tsx scripts/backfill-automated.ts --apply   # change it
 *
 * Every sync run does the same correction (#177), so this is for correcting
 * an index before a build with that change is deployed, or without running a
 * sync. Running it again changes nothing.
 *
 * It reads MINDMELD_AUTOMATED_PREFIXES from .env, and prints how many prefixes
 * it sees: with none, every prefix-flagged session would be cleared, so check
 * that number against your deployment before applying.
 */

import 'dotenv/config'
import { config } from '../src/config.js'
import { closePool, query } from '../src/db/postgres.js'
import { USELESS_TAG } from '../src/mcp/noise.js'
import { correctAutomatedDrift, findAutomatedDrift } from '../src/embeddings/automated-flags.js'

const apply = process.argv.includes('--apply')

const counts = async () => {
  const { rows } = await query<{ automated: string; noise: string }>(
    `SELECT COUNT(*) FILTER (WHERE s.is_automated) AS automated,
            COUNT(*) FILTER (WHERE s.is_automated OR EXISTS (SELECT 1 FROM tags t WHERE t.session_id = s.id AND t.tag = $1)) AS noise
     FROM sessions s WHERE s.deleted_at IS NULL`,
    [USELESS_TAG]
  )
  return `automated ${rows[0].automated}, automated or ${USELESS_TAG} ${rows[0].noise}`
}

const run = async () => {
  console.log(`Configured automated prefixes: ${config.automated.prefixes.length}`)
  console.log(`Before: ${await counts()}`)

  const drift = await findAutomatedDrift()
  const groups = new Map<string, number>()
  for (const d of drift) {
    const key = `${d.source}\t${d.machine ?? '(none)'}\t${d.stored ? 'clear flag' : 'set flag'}`
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  console.log(`\n${drift.length} sessions disagree with the classifier`)
  console.log('source\tmachine\tchange\tsessions')
  for (const [key, n] of [...groups].sort()) console.log(`${key}\t${n}`)

  if (!apply) {
    console.log('\nDry run. Pass --apply to change them.')
    return
  }
  const changed = await correctAutomatedDrift(drift)
  console.log(`\nChanged ${changed} sessions`)
  console.log(`After: ${await counts()}`)
}

run()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(closePool)
