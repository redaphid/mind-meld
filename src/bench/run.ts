import { existsSync } from 'node:fs'
import path from 'node:path'
import { sessionIdsMatchingPaths, startedAtOf } from './corpus.js'
import { judgePairs, type Pair } from './judge.js'
import { compareScores, indexJudgments, reportScores, scoreRuns, visibleResults, type Visibility } from './score.js'
import { appendJsonl, benchFiles, loadBench, readJson, readJsonl, writeJson } from './store.js'
import { BUILTIN_SYSTEMS, deriveRun, searcherFor, type Searcher, type SystemSpec } from './systems.js'
import type { BenchQuery, Manifest, Run, StratumReport } from './types.js'

const STATUS_URL = 'http://127.0.0.1:3847/api/system'

// The GPU gate decides whether search embeds at once or waits; a run made
// behind a busy gate measures the queue, not search. Read-only GET.
export const gateState = async (): Promise<unknown> => {
  try {
    const response = await fetch(STATUS_URL, { signal: AbortSignal.timeout(5000) })
    const body = (await response.json()) as { ollama?: { gate?: unknown } }
    return body.ollama?.gate ?? body
  } catch (e) {
    return { unavailable: e instanceof Error ? e.message : String(e) }
  }
}

export const resolveSystems = (names: string[], configFile?: string): Map<string, SystemSpec> => {
  const configured = configFile ? (readJson<{ systems?: Record<string, SystemSpec> }>(configFile).systems ?? {}) : {}
  const all = { ...BUILTIN_SYSTEMS, ...configured }
  return new Map(
    names.map((name) => {
      const spec = all[name]
      if (!spec) throw new Error(`unknown system ${name}; known: ${Object.keys(all).join(', ')}`)
      return [name, spec]
    })
  )
}

export const visibilityFor = async (manifest: Manifest): Promise<Visibility> => ({
  snapshotMaxSessionId: manifest.snapshotMaxSessionId,
  excludedSessionIds: new Set(await sessionIdsMatchingPaths(manifest.excludePathPatterns)),
})

export type RunOptions = {
  dir: string
  systems: string[]
  config?: string
  name: string
  // Derived systems reorder this saved run of their base system.
  from?: string
  judge: boolean
  degradedRetries?: number
  log?: (line: string) => void
}

const DEGRADED_WAIT_MS = 20_000

const runSearches = async (
  queries: BenchQuery[],
  searchers: Map<string, Searcher>,
  files: ReturnType<typeof benchFiles>,
  name: string,
  retries: number,
  log: (line: string) => void
) => {
  const done = new Map([...searchers.keys()].map((s) => [s, new Set(readJsonl<Run>(files.run(`${name}-${s}`)).map((r) => r.queryId))]))
  const systems = [...searchers.keys()]
  let retried = 0
  for (const [qi, query] of queries.entries()) {
    // Rotate which system goes first so warm caches favour none of them.
    const order = systems.map((_, i) => systems[(i + qi) % systems.length])
    for (const system of order) {
      if (done.get(system)!.has(query.id)) continue
      let run = await searchers.get(system)!(query)
      for (let attempt = 0; run.degraded && attempt < retries; attempt++) {
        retried++
        log(`degraded (${run.degraded}); waiting before retry ${attempt + 1}`)
        await new Promise((r) => setTimeout(r, DEGRADED_WAIT_MS))
        run = await searchers.get(system)!(query)
      }
      const started = await startedAtOf(run.results.map((r) => r.sessionId))
      const full: Run = { system, ...run, results: run.results.map((r) => ({ ...r, startedAt: started.get(r.sessionId) ?? null })) }
      appendJsonl(files.run(`${name}-${system}`), [full])
    }
    if ((qi + 1) % 25 === 0) log(`searched ${qi + 1}/${queries.length}`)
  }
  return retried
}

// Every pair the pool systems put in a visible top ten, plus every gold
// session, that the cache has no grade for yet.
export const missingPairs = (queries: BenchQuery[], runs: Run[], judged: Set<string>, visibility: Visibility): Pair[] => {
  const byQuery = new Map(queries.map((q) => [q.id, q]))
  const pairs = new Map<string, Pair>()
  const add = (query: BenchQuery, sessionId: number, snippet: string | null) => {
    const key = `${query.id}:${sessionId}`
    if (judged.has(key)) return
    const pair = pairs.get(key) ?? { query, sessionId, snippets: [] }
    if (snippet && pair.snippets.length < 2 && !pair.snippets.includes(snippet)) pair.snippets.push(snippet)
    pairs.set(key, pair)
  }
  for (const query of queries) for (const id of query.goldSessionIds) add(query, id, null)
  for (const run of runs) {
    const query = byQuery.get(run.queryId)
    if (!query) continue
    for (const r of visibleResults(run, query, visibility)) add(query, r.sessionId, r.snippet)
  }
  return [...pairs.values()]
}

export const judgeMissing = async (dir: string, runs: Run[], log: (line: string) => void) => {
  const { files, manifest, queries, judgments } = loadBench(dir)
  const visibility = await visibilityFor(manifest)
  const judged = new Set(
    judgments.filter((j) => j.promptVersion === manifest.promptVersion && j.repeat === 0).map((j) => `${j.queryId}:${j.sessionId}`)
  )
  const pairs = missingPairs(queries, runs, judged, visibility)
  if (pairs.length === 0) return 0
  log(`judging ${pairs.length} new pairs`)
  await judgePairs(pairs, {
    model: manifest.judgeModel,
    cwd: files.judgeCwd,
    out: files.judgments,
    onBatch: (done, total) => done % 20 === 0 && log(`judged batch ${done}/${total}`),
  })
  return pairs.length
}

export const scoreSavedRun = async (dir: string, runs: Run[]) => {
  const { manifest, queries, judgments } = loadBench(dir)
  return scoreRuns(queries, runs, indexJudgments(judgments, manifest.promptVersion), await visibilityFor(manifest))
}

export const runBench = async ({ dir, systems, config, name, from, judge, degradedRetries = 2, log = console.error }: RunOptions) => {
  const { files, queries } = loadBench(dir)
  const specs = resolveSystems(systems, config)
  const configDir = config ? path.dirname(path.resolve(config)) : process.cwd()
  const live = [...specs].filter(([, spec]) => !spec.derive)
  const searchers = new Map(await Promise.all(live.map(async ([s, spec]) => [s, await searcherFor(spec, configDir)] as const)))

  const gateBefore = await gateState()
  const retried = await runSearches(queries, searchers, files, name, degradedRetries, log)
  const gateAfter = await gateState()

  for (const [system, spec] of specs) {
    if (!spec.derive) continue
    const base = from ?? `${name}-${spec.derive.from}`
    const baseFile = files.run(base)
    if (!existsSync(baseFile)) throw new Error(`${system} reorders saved run ${base}, which does not exist`)
    const derived = readJsonl<Run>(baseFile).map((r) => deriveRun(r, system, spec.derive!.transform))
    writeJson(files.runMeta(`${name}-${system}`), { system, spec, derivedFrom: base })
    if (!existsSync(files.run(`${name}-${system}`))) appendJsonl(files.run(`${name}-${system}`), derived)
  }
  for (const [system, spec] of live)
    writeJson(files.runMeta(`${name}-${system}`), { system, spec, gateBefore, gateAfter, degradedRetries: retried, finishedAt: new Date().toISOString() })

  const runsBySystem = new Map([...specs.keys()].map((s) => [s, readJsonl<Run>(files.run(`${name}-${s}`))]))
  if (judge) await judgeMissing(dir, [...runsBySystem.values()].flat(), log)

  const lines: { system: string; run: string; reports: StratumReport[] }[] = []
  for (const [system, runs] of runsBySystem) {
    const reports = reportScores(system, await scoreSavedRun(dir, runs))
    writeJson(path.join(dir, 'reports', `${name}-${system}.json`), reports)
    lines.push({ system, run: `${name}-${system}`, reports })
  }
  return lines
}

export const compareRuns = async (dir: string, a: string, b: string, judge: boolean, log = console.error) => {
  const files = benchFiles(dir)
  const aRuns = readJsonl<Run>(files.run(a))
  const bRuns = readJsonl<Run>(files.run(b))
  if (aRuns.length === 0 || bRuns.length === 0) throw new Error(`missing run: ${aRuns.length === 0 ? a : b}`)
  if (judge) await judgeMissing(dir, [...aRuns, ...bRuns], log)
  return compareScores(a, await scoreSavedRun(dir, aRuns), b, await scoreSavedRun(dir, bRuns))
}
