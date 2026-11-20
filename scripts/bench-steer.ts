/**
 * The steering stratum: does handing search example sessions move results the
 * right way? Gold recall@20 and nDCG@10 gained from toward examples, share of
 * off-target results removed by away examples, and the collateral share of
 * on-target results lost with them.
 *
 *   pnpm run bench:steer -- --dir <bench> --config systems.json --build --seed <seed> [--target 40]
 *   pnpm run bench:steer -- --dir <bench> --config systems.json --name <run>
 *                           --base <system> --toward <system> --away <system>
 *
 * Systems must search 20 deep (params.limit 20); toward and away systems set
 * "steer": "toward" / "away" to receive the examples.
 */
import 'dotenv/config'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { closePool } from '../src/db/postgres.js'
import { resolveBenchDir, resolveRunName } from '../src/bench/dir.js'
import { resolveSystems } from '../src/bench/run.js'
import { buildSteering, runSteering } from '../src/bench/steering.js'
import { searcherFor } from '../src/bench/systems.js'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    dir: { type: 'string' },
    config: { type: 'string' },
    build: { type: 'boolean', default: false },
    seed: { type: 'string' },
    target: { type: 'string', default: '40' },
    name: { type: 'string' },
    base: { type: 'string', default: 'hybrid-20' },
    toward: { type: 'string', default: 'hybrid-20-toward' },
    away: { type: 'string', default: 'hybrid-20-away' },
  },
})
const dir = resolveBenchDir(values.dir ?? process.env.MINDMELD_BENCH_DIR, fileURLToPath(new URL('..', import.meta.url)))
const configDir = values.config ? path.dirname(path.resolve(values.config)) : process.cwd()
const names = { base: values.base!, toward: values.toward!, away: values.away! }
const specs = resolveSystems(Object.values(names), values.config)
const searcher = async (name: string) => searcherFor(specs.get(name)!, configDir)
const log = (line: string) => console.error(line)

if (values.build) {
  if (!values.seed) throw new Error('name a --seed for the steering sample')
  const items = await buildSteering({ dir, seed: values.seed, base: await searcher(names.base), target: Number(values.target), log })
  console.log(JSON.stringify({ items: items.length }))
} else {
  const report = await runSteering(
    dir,
    resolveRunName(values.name),
    { base: await searcher(names.base), toward: await searcher(names.toward), away: await searcher(names.away), names },
    log
  )
  console.log(JSON.stringify(report))
}
await closePool()
// A --config module brings its own database pool; do not wait on it.
process.exit(0)
