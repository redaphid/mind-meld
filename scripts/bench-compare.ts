/**
 * Paired comparison of two saved benchmark runs: b minus a, per stratum and
 * metric, 10,000 paired bootstrap resamples over queries, fixed seed.
 *
 *   pnpm run bench:compare -- --dir <bench> --a <run> --b <run> [--no-judge]
 *
 * Runs are file names under <bench>/runs without .jsonl, e.g. base-hybrid.
 */
import 'dotenv/config'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { closePool } from '../src/db/postgres.js'
import { resolveBenchDir, resolveRunName } from '../src/bench/dir.js'
import { compareRuns } from '../src/bench/run.js'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    dir: { type: 'string' },
    a: { type: 'string' },
    b: { type: 'string' },
    'no-judge': { type: 'boolean', default: false },
  },
})
if (!values.a || !values.b) throw new Error('name both runs: --a <run> --b <run>')
const dir = resolveBenchDir(values.dir ?? process.env.MINDMELD_BENCH_DIR, fileURLToPath(new URL('..', import.meta.url)))
const comparisons = await compareRuns(dir, resolveRunName(values.a), resolveRunName(values.b), !values['no-judge'])
console.log(JSON.stringify({ a: values.a, b: values.b, comparisons }))
await closePool()
// A --config module brings its own database pool; do not wait on it.
process.exit(0)
