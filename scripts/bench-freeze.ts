/**
 * Freeze a built benchmark: stamp counts, harness commit and the query-set
 * hash into its manifest. Scoring refuses a frozen set whose queries change.
 *
 *   pnpm run bench:freeze -- --dir <bench> [--note "..."]
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolveBenchDir } from '../src/bench/dir.js'
import { benchFiles, readJson, readJsonl, sha256Of, writeJson } from '../src/bench/store.js'
import { STRATA, type BenchQuery, type Manifest } from '../src/bench/types.js'

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { dir: { type: 'string' }, note: { type: 'string', multiple: true } },
})
const repo = fileURLToPath(new URL('..', import.meta.url))
const dir = resolveBenchDir(values.dir ?? process.env.MINDMELD_BENCH_DIR, repo)
const files = benchFiles(dir)
const manifest = readJson<Manifest>(files.manifest)
if (manifest.frozenAt) throw new Error(`already frozen at ${manifest.frozenAt}`)
const queries = readJsonl<BenchQuery>(files.queries)
const frozen: Manifest = {
  ...manifest,
  frozenAt: new Date().toISOString(),
  counts: Object.fromEntries(STRATA.map((s) => [s, queries.filter((q) => q.stratum === s).length])),
  harnessSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  queriesSha256: sha256Of(files.queries),
  notes: [...manifest.notes, ...(values.note ?? [])],
}
writeJson(files.manifest, frozen)
console.log(JSON.stringify({ frozenAt: frozen.frozenAt, counts: frozen.counts, harnessSha: frozen.harnessSha }))
