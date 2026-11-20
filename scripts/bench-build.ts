/**
 * Build the benchmark query set in a bench directory outside this repository.
 *
 *   pnpm run bench:build -- --dir <bench> --seed <seed> [--config systems.json]
 *                           [--exclude-path <LIKE pattern> ...] [--stratum natural ...]
 *
 * Idempotent: strata already built are skipped and the first snapshot is kept.
 * Haiku writes the queries through a hermetic `claude -p` (src/bench/claude.ts).
 * --config names the systems file whose text and semantic systems verify
 * that no-answer topics are absent.
 */
import 'dotenv/config'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { closePool } from '../src/db/postgres.js'
import { resolveBenchDir } from '../src/bench/dir.js'
import { buildBench } from '../src/bench/build.js'
import { resolveSystems } from '../src/bench/run.js'
import { searcherFor } from '../src/bench/systems.js'
import path from 'node:path'
import { STRATA, type Stratum } from '../src/bench/types.js'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    dir: { type: 'string' },
    seed: { type: 'string' },
    'exclude-path': { type: 'string', multiple: true },
    stratum: { type: 'string', multiple: true },
    config: { type: 'string' },
  },
})
if (!values.seed) throw new Error('name a --seed: it fixes the session sample')
const strata = values.stratum?.map((s) => {
  if (!STRATA.includes(s as Stratum)) throw new Error(`unknown stratum ${s}`)
  return s as Stratum
})
const dir = resolveBenchDir(values.dir ?? process.env.MINDMELD_BENCH_DIR, fileURLToPath(new URL('..', import.meta.url)))
// No-answer topics are verified absent with the system under test, which a
// --config can point at another checkout's search code.
const specs = resolveSystems(['text', 'semantic'], values.config)
const configDir = values.config ? path.dirname(path.resolve(values.config)) : process.cwd()
const search = {
  text: await searcherFor(specs.get('text')!, configDir),
  semantic: await searcherFor(specs.get('semantic')!, configDir),
}
console.log(
  JSON.stringify(await buildBench({ dir, seed: values.seed, excludePathPatterns: values['exclude-path'] ?? [], search, strata }))
)
await closePool()
// A --config module brings its own database pool; do not wait on it.
process.exit(0)
