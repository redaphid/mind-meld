/**
 * Score named search systems on the frozen retrieval benchmark.
 *
 *   pnpm run bench -- --dir <bench> --system hybrid [--system text ...] [--name run-id]
 *                     [--config systems.json] [--from saved-run] [--no-judge]
 *
 * Runs the systems interleaved per query (one search at a time, so latency is
 * comparable), saves each run to <bench>/runs, judges result pairs the cache
 * has not graded, and prints one JSON line per system. Read-only against the
 * live stores; the bench directory holds personal data and must be outside
 * this repository.
 */
import 'dotenv/config'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { closePool } from '../src/db/postgres.js'
import { resolveBenchDir } from '../src/bench/dir.js'
import { loadBench } from '../src/bench/store.js'
import { runBench } from '../src/bench/run.js'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    dir: { type: 'string' },
    system: { type: 'string', multiple: true },
    name: { type: 'string' },
    config: { type: 'string' },
    from: { type: 'string' },
    'no-judge': { type: 'boolean', default: false },
  },
})

const dir = resolveBenchDir(values.dir ?? process.env.MINDMELD_BENCH_DIR, fileURLToPath(new URL('..', import.meta.url)))
if (!loadBench(dir).manifest.frozenAt) console.error('WARNING: this bench is not frozen; its numbers are not comparable yet.')
const lines = await runBench({
  dir,
  systems: values.system ?? ['hybrid'],
  config: values.config,
  name: values.name ?? new Date().toISOString().replace(/[:.]/g, '-'),
  from: values.from,
  judge: !values['no-judge'],
})
for (const line of lines) console.log(JSON.stringify(line))
await closePool()
// A --config module brings its own database pool; do not wait on it.
process.exit(0)
