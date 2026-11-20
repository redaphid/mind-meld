import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BenchQuery, Run } from './types.js'

const search = vi.hoisted(() => ({ params: [] as Record<string, unknown>[] }))

vi.mock('../mcp/search.js', () => ({
  searchWithDiagnostics: async (params: Record<string, unknown>) => {
    search.params.push(params)
    return {
      results: [
        { session_id: 7, score: 0.9, matched_tier: 'session', snippet: 'snippet-wobbly-yak' },
        { session_id: 3, score: 0.4, matched_tier: 'message', snippet: null },
      ],
      degraded: null,
      projectIds: [],
      armMs: {},
    }
  },
}))

const { BUILTIN_SYSTEMS, deriveRun, searcherFor, searchUndegraded } = await import('./systems.js')

const query: BenchQuery = {
  id: 'query-id-soggy-lantern',
  stratum: 'real',
  text: 'query-text-velvet-anchor',
  dataClass: ['coding'],
  goldSessionIds: [7],
  goldSummaryKind: 'generated',
  goldProjectPath: '/projects/gold-path-mossy-gate',
  sourceNote: 'fixture',
  replay: { cwd: '/projects/replay-path-dusty-owl', since: '2026-01-01T00:00:00.000Z', projectOnly: true },
  notAfter: null,
  excludeSessionIds: [],
  steering: { toward: [11, 12], away: [21] },
}

beforeEach(() => {
  search.params.length = 0
})

const paramsOf = async (spec: Parameters<typeof searcherFor>[0]) => {
  await (await searcherFor(spec, process.cwd()))(query)
  return search.params[0]
}

describe('searcherFor', () => {
  it('replays the query cwd, since, projectOnly and dataClass by default', async () => {
    expect(await paramsOf(BUILTIN_SYSTEMS.hybrid)).toMatchObject({
      query: 'query-text-velvet-anchor',
      mode: 'hybrid',
      limit: 10,
      dataClass: ['coding'],
      cwd: '/projects/replay-path-dusty-owl',
      since: '2026-01-01T00:00:00.000Z',
      projectOnly: true,
    })
  })

  // The project-boost diagnosis must search from the gold session's project.
  it("uses the gold project path for cwd 'gold'", async () => {
    expect((await paramsOf(BUILTIN_SYSTEMS['hybrid-gold-cwd'])).cwd).toBe('/projects/gold-path-mossy-gate')
  })

  it("drops the cwd for cwd 'none'", async () => {
    expect((await paramsOf(BUILTIN_SYSTEMS['hybrid-no-cwd'])).cwd).toBeUndefined()
  })

  it('lets system params override the query defaults', async () => {
    expect((await paramsOf({ params: { mode: 'text', limit: 20 } })).limit).toBe(20)
  })

  it('hands only the toward examples to a toward system', async () => {
    const params = await paramsOf({ steer: 'toward' })
    expect(params.likeSession).toEqual(['11', '12'])
    expect(params.steering).toEqual({ toward: [11, 12] })
    expect(params.unlikeSession).toBeUndefined()
  })

  it('hands only the away examples to an away system', async () => {
    const params = await paramsOf({ steer: 'away' })
    expect(params.unlikeSession).toEqual(['21'])
    expect(params.steering).toEqual({ away: [21] })
    expect(params.likeSession).toBeUndefined()
  })

  it('sends no examples to an unsteered system', async () => {
    const params = await paramsOf({})
    expect(params.likeSession).toBeUndefined()
    expect(params.unlikeSession).toBeUndefined()
    expect(params.steering).toBeUndefined()
  })

  it('maps results to 1-based ranks in the order search returned them', async () => {
    const run = await (await searcherFor({}, process.cwd()))(query)
    expect(run.queryId).toBe('query-id-soggy-lantern')
    expect(run.degraded).toBeNull()
    expect(run.results).toEqual([
      { sessionId: 7, rank: 1, score: 0.9, matchedTier: 'session', startedAt: null, snippet: 'snippet-wobbly-yak' },
      { sessionId: 3, rank: 2, score: 0.4, matchedTier: 'message', startedAt: null, snippet: null },
    ])
  })

  // `module` swaps the code path, resolved against the config file's directory.
  it('searches through a module named relative to the config directory', async () => {
    const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'bench-systems-')))
    writeFileSync(
      path.join(dir, 'other-search.mjs'),
      `export const searchWithDiagnostics = async (p) => ({ results: [{ session_id: 99, score: 1, matched_tier: 'chunk', snippet: p.query }], degraded: { reason: 'reason-text-hazy-moth' } })\n`
    )
    const run = await (await searcherFor({ module: './other-search.mjs' }, dir))(query)
    expect(run.results.map((r) => [r.sessionId, r.snippet])).toEqual([[99, 'query-text-velvet-anchor']])
    expect(run.degraded).toBe('reason-text-hazy-moth')
    expect(search.params).toHaveLength(0)
  })

  it('rejects a module that does not export searchWithDiagnostics', async () => {
    const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'bench-systems-')))
    writeFileSync(path.join(dir, 'empty.mjs'), 'export const unrelated = 1\n')
    await expect(searcherFor({ module: 'empty.mjs' }, dir)).rejects.toThrow(/does not export searchWithDiagnostics/)
  })
})

const runOf = (degraded: string | null): Omit<Run, 'system'> => ({ queryId: query.id, results: [], latencyMs: 1, degraded })

describe('searchUndegraded', () => {
  it('retries a degraded search and returns the first clean one', async () => {
    const searcher = vi.fn().mockResolvedValueOnce(runOf('gate-busy')).mockResolvedValueOnce(runOf(null))
    const { run, retries } = await searchUndegraded(searcher, query, 2, () => {}, 0)
    expect(run.degraded).toBeNull()
    expect(retries).toBe(1)
    expect(searcher).toHaveBeenCalledTimes(2)
  })

  it('keeps a search still degraded after the retry budget, and counts the retries', async () => {
    const searcher = vi.fn().mockResolvedValue(runOf('gate-busy'))
    const { run, retries } = await searchUndegraded(searcher, query, 2, () => {}, 0)
    expect(run.degraded).toBe('gate-busy')
    expect(retries).toBe(2)
    expect(searcher).toHaveBeenCalledTimes(3)
  })

  it('does not search again when the first search is clean', async () => {
    const searcher = vi.fn().mockResolvedValue(runOf(null))
    expect((await searchUndegraded(searcher, query, 2, () => {}, 0)).retries).toBe(0)
    expect(searcher).toHaveBeenCalledTimes(1)
  })
})

describe('deriveRun', () => {
  const base: Run = {
    system: 'hybrid',
    queryId: 'query-id-soggy-lantern',
    latencyMs: 5,
    degraded: null,
    results: [1, 2, 3, 4, 5, 6, 7, 8].map((sessionId, i) => ({
      sessionId,
      rank: i + 1,
      score: 1 - i / 10,
      matchedTier: 'session' as const,
      startedAt: null,
      snippet: null,
    })),
  }

  it('reverses the saved order and renumbers ranks', () => {
    const derived = deriveRun(base, 'hybrid-reversed', 'reverse')
    expect(derived.system).toBe('hybrid-reversed')
    expect(derived.results.map((r) => r.sessionId)).toEqual([8, 7, 6, 5, 4, 3, 2, 1])
    expect(derived.results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(base.results[0].sessionId).toBe(1)
  })

  it('shuffles reproducibly into a permutation of the saved results', () => {
    const a = deriveRun(base, 'hybrid-shuffled', 'shuffle')
    const b = deriveRun(base, 'hybrid-shuffled', 'shuffle')
    expect(a.results.map((r) => r.sessionId)).toEqual(b.results.map((r) => r.sessionId))
    expect(a.results.map((r) => r.sessionId)).not.toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...a.results.map((r) => r.sessionId)].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(a.results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})
