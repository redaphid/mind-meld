/**
 * Bring sessions.is_automated into agreement with classifyAutomated.
 *
 *   pnpm tsx scripts/backfill-automated.ts                                 # dry run
 *   pnpm tsx scripts/backfill-automated.ts --apply --snapshot before.tsv   # change it
 *   pnpm tsx scripts/backfill-automated.ts --restore before.tsv            # undo it
 *
 * Sync only ever SETS the flag (#177), so a worker missing the prefix list
 * cannot fight a configured one. Clearing a flag that the classifier no longer
 * explains (a prefix removed, a retired rule) happens here and nowhere else.
 * Running it again changes nothing. Run it between sync cycles.
 *
 * --apply first writes the id and old flag of every session it will change to
 * the --snapshot file, and --restore puts exactly those flags back.
 *
 * It reads MINDMELD_AUTOMATED_PREFIXES from .env, and prints how many prefixes
 * it sees. With none it would clear every prefix-flagged session, so it refuses
 * to clear anything then unless --allow-no-prefixes is passed.
 */

import 'dotenv/config'
import { readFile, writeFile } from 'node:fs/promises'
import { config } from '../src/config.js'
import { closePool, query } from '../src/db/postgres.js'
import { USELESS_TAG } from '../src/mcp/noise.js'
import { correctAutomatedDrift, findAutomatedDrift } from '../src/embeddings/automated-flags.js'

const argv = process.argv.slice(2)
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const apply = argv.includes('--apply')
const snapshot = option('--snapshot')
const restoreFrom = option('--restore')

const counts = async () => {
  const { rows } = await query<{ automated: string; noise: string }>(
    `SELECT COUNT(*) FILTER (WHERE s.is_automated) AS automated,
            COUNT(*) FILTER (WHERE s.is_automated OR EXISTS (SELECT 1 FROM tags t WHERE t.session_id = s.id AND t.tag = $1)) AS noise
     FROM sessions s WHERE s.deleted_at IS NULL`,
    [USELESS_TAG]
  )
  return `automated ${rows[0].automated}, automated or ${USELESS_TAG} ${rows[0].noise}`
}

const restore = async (file: string) => {
  const rows = (await readFile(file, 'utf8'))
    .split('\n')
    .filter((line) => /^\d+\t(true|false)$/.test(line))
    .map((line) => line.split('\t'))
  const { rowCount } = await query(
    `UPDATE sessions s SET is_automated = r.stored
     FROM unnest($1::int[], $2::boolean[]) AS r(id, stored)
     WHERE s.id = r.id AND s.is_automated <> r.stored`,
    [rows.map(([id]) => Number(id)), rows.map(([, stored]) => stored === 'true')]
  )
  console.log(`Restored ${rowCount} of ${rows.length} sessions from ${file}`)
  console.log(`After: ${await counts()}`)
}

const correct = async () => {
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
    console.log('\nDry run. Pass --apply --snapshot <file> to change them.')
    return
  }
  if (!snapshot) throw new Error('--apply needs --snapshot <file>, so the change can be restored')
  if (config.automated.prefixes.length === 0 && drift.some((d) => d.stored) && !argv.includes('--allow-no-prefixes'))
    throw new Error(
      'No automated prefixes are configured, so this would clear every prefix-flagged session. Pass --allow-no-prefixes if that is intended.'
    )
  await writeFile(snapshot, 'id\tstored\n' + drift.map((d) => `${d.id}\t${d.stored}\n`).join(''))
  console.log(`\nWrote the old flags of ${drift.length} sessions to ${snapshot}; undo with --restore ${snapshot}`)
  const changed = await correctAutomatedDrift(drift)
  console.log(`Changed ${changed} sessions`)
  console.log(`After: ${await counts()}`)
}

;(restoreFrom ? restore(restoreFrom) : correct())
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(closePool)
