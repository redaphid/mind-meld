import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { searchWithDiagnostics, type SearchOutcome, type SearchParams } from '../mcp/search.js'
import { shuffled } from './metrics.js'
import { K } from './score.js'
import type { BenchQuery, Run } from './types.js'

// A named system is what an experiment changes; the frozen query set never
// does. Parameters merge over the query's own; `module` swaps the code path
// for any file exporting `searchWithDiagnostics`; `derive` reorders another
// system's saved run, which is how the deliberately broken controls are made.
export type SystemSpec = {
  params?: Partial<SearchParams>
  // Which cwd the search sees: the query's own (real queries replay theirs),
  // none, or the gold session's project path (the project-boost diagnosis).
  cwd?: 'query' | 'none' | 'gold'
  module?: string
  // On steering items, hand the examples to search: today as likeSession /
  // unlikeSession ids, and to a module also as `steering` on its params, so a
  // recipe-based search can read them without a legacy parameter.
  steer?: 'toward' | 'away'
  derive?: { from: string; transform: 'reverse' | 'shuffle' }
}

export const BUILTIN_SYSTEMS: Record<string, SystemSpec> = {
  text: { params: { mode: 'text' } },
  semantic: { params: { mode: 'semantic' } },
  hybrid: { params: { mode: 'hybrid' } },
  'hybrid-noise-off': { params: { mode: 'hybrid', includeNoise: true } },
  'hybrid-no-cwd': { params: { mode: 'hybrid' }, cwd: 'none' },
  'hybrid-gold-cwd': { params: { mode: 'hybrid' }, cwd: 'gold' },
  'hybrid-reversed': { derive: { from: 'hybrid', transform: 'reverse' } },
  'hybrid-shuffled': { derive: { from: 'hybrid', transform: 'shuffle' } },
}

type SearchFn = (params: BenchSearchParams) => Promise<SearchOutcome>

const loadSearch = async (spec: SystemSpec, configDir: string): Promise<SearchFn> => {
  if (!spec.module) return searchWithDiagnostics
  const loaded = (await import(pathToFileURL(path.resolve(configDir, spec.module)).href)) as {
    searchWithDiagnostics?: SearchFn
  }
  if (typeof loaded.searchWithDiagnostics !== 'function')
    throw new Error(`${spec.module} does not export searchWithDiagnostics`)
  return loaded.searchWithDiagnostics
}

export type BenchSearchParams = SearchParams & { steering?: { toward?: number[]; away?: number[] } }

export const paramsFor = (query: BenchQuery, spec: SystemSpec): BenchSearchParams => {
  const cwd =
    spec.cwd === 'none' ? undefined : spec.cwd === 'gold' ? (query.goldProjectPath ?? undefined) : query.replay.cwd
  const toward = spec.steer === 'toward' ? query.steering?.toward : undefined
  const away = spec.steer === 'away' ? query.steering?.away : undefined
  return {
    ...(toward && { likeSession: toward.map(String), steering: { toward } }),
    ...(away && { unlikeSession: away.map(String), steering: { away } }),
    query: query.text,
    limit: K,
    dataClass: query.dataClass,
    since: query.replay.since,
    projectOnly: query.replay.projectOnly,
    cwd,
    ...spec.params,
  }
}

export type Searcher = (query: BenchQuery) => Promise<Omit<Run, 'system'>>

export const searcherFor = async (spec: SystemSpec, configDir: string): Promise<Searcher> => {
  const search = await loadSearch(spec, configDir)
  return async (query) => {
    const started = performance.now()
    const outcome = await search(paramsFor(query, spec))
    const latencyMs = performance.now() - started
    return {
      queryId: query.id,
      latencyMs,
      degraded: outcome.degraded?.reason ?? null,
      results: outcome.results.map((r, i) => ({
        sessionId: r.session_id,
        rank: i + 1,
        score: r.score,
        matchedTier: r.matched_tier,
        startedAt: null,
        snippet: r.snippet,
      })),
    }
  }
}

const DEGRADED_WAIT_MS = 20_000

// A degraded search measures the embedding queue, not ranking, so it is
// retried after a pause; one still degraded after that is kept and counted.
export const searchUndegraded = async (
  search: Searcher,
  query: BenchQuery,
  retries: number,
  log: (line: string) => void,
  waitMs = DEGRADED_WAIT_MS
) => {
  let run = await search(query)
  let attempts = 0
  for (; run.degraded && attempts < retries; attempts++) {
    log(`degraded (${run.degraded}); waiting before retry ${attempts + 1}`)
    await new Promise((r) => setTimeout(r, waitMs))
    run = await search(query)
  }
  return { run, retries: attempts }
}

export const deriveRun =(base: Run, system: string, transform: 'reverse' | 'shuffle'): Run => {
  const ordered =
    transform === 'reverse' ? [...base.results].reverse() : shuffled(base.results, `${system}:${base.queryId}`)
  return { ...base, system, results: ordered.map((r, i) => ({ ...r, rank: i + 1 })) }
}
