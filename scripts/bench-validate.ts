/**
 * Is the judge usable? Gold sanity, test-retest on a seeded tenth of judged
 * pairs, and agreement with an independent grader.
 *
 *   pnpm run bench:validate -- --dir <bench> [--retest] [--export-opus]
 *
 * --export-opus writes <bench>/validation/opus-pairs.md for an independent
 * grader, who writes opus-grades.json beside it; later runs report agreement.
 */
import 'dotenv/config'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { closePool } from '../src/db/postgres.js'
import { resolveBenchDir } from '../src/bench/dir.js'
import { writeJson } from '../src/bench/store.js'
import { exportForOpus, goldSanity, opusAgreement, retest } from '../src/bench/validate.js'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    dir: { type: 'string' },
    retest: { type: 'boolean', default: false },
    'export-opus': { type: 'boolean', default: false },
  },
})
const dir = resolveBenchDir(values.dir ?? process.env.MINDMELD_BENCH_DIR, fileURLToPath(new URL('..', import.meta.url)))
const report = {
  goldSanity: goldSanity(dir),
  retest: values.retest ? await retest(dir) : null,
  opusExport: values['export-opus'] ? await exportForOpus(dir) : null,
  opus: opusAgreement(dir),
}
writeJson(path.join(dir, 'validation', 'judge-report.json'), report)
console.log(JSON.stringify(report))
await closePool()
// A --config module brings its own database pool; do not wait on it.
process.exit(0)
