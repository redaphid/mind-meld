import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BenchQuery, Judgment, Run, StratumReport } from './types.js'

const fake = vi.hoisted(() => ({
  searches: [] as { mode: string; query: string }[],
  prompts: [] as string[],
  startedAt: new Map<number, string | null>(),
  refused: new Set<number>(),
}))

// text ranks the gold session first, semantic second; both also return a
// session above the snapshot, which scoring and judging must ignore.
vi.mock('../mcp/search.js', () => ({
  searchWithDiagnostics: async ({ mode, query }: { mode: string; query: string }) => {
    fake.searches.push({ mode, query })
    const gold = Number(query.split(':')[1])
    const ids = mode === 'semantic' ? [900, gold, 2000] : [gold, 900, 2000]
    return {
      results: ids.map((id, i) => ({ session_id: id, score: 1 - i / 10, matched_tier: 'session', snippet: `snippet-${mode}-${id}` })),
      degraded: null,
      projectIds: [],
      armMs: {},
    }
  },
}))

vi.mock('./corpus.js', () => ({
  startedAtOf: async (ids: number[]) => new Map(ids.map((id) => [id, fake.startedAt.get(id) ?? null])),
  sessionIdsMatchingPaths: async () => [],
  sessionCard: async (sessionId: number) => ({
    sessionId,
    title: `title-${sessionId}`,
    summary: 'summary-tangled-kite',
    summaryKind: 'generated',
    dataClass: 'coding',
    projectPath: null,
    startedAt: null,
    chunkSummaries: [],
    messages: [],
  }),
}))

// The judge grades a gold session (id 1xx) 3 and anything else 0, and refuses
// any prompt that shows a session in fake.refused.
vi.mock('./claude.js', async (original) => {
  const actual = await original<typeof import('./claude.js')>()
  return {
    ...actual,
    callClaude: async ({ prompt }: { prompt: string }) => {
      fake.prompts.push(prompt)
      const cards = [...prompt.matchAll(/### Candidate (C\d+)\nTitle: title-(\d+)/g)]
      if (cards.some(([, , id]) => fake.refused.has(Number(id)))) throw new actual.ModelRefusal('refused')
      return JSON.stringify({ grades: Object.fromEntries(cards.map(([, label, id]) => [label, Number(id) < 200 ? 3 : 0])) })
    },
  }
})

const { compareRuns, resolveSystems, runBench } = await import('./run.js')

const query = (id: string, gold: number): BenchQuery => ({
  id,
  stratum: 'natural',
  text: `query-text-velvet-anchor:${gold}`,
  dataClass: ['coding'],
  goldSessionIds: [gold],
  goldSummaryKind: 'generated',
  goldProjectPath: null,
  sourceNote: 'fixture',
  replay: {},
  notAfter: null,
  excludeSessionIds: [],
})

const QUERIES = [query('q-a', 101), query('q-b', 102), query('q-c', 103)]

const bench = () => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'bench-run-')))
  writeFileSync(path.join(dir, 'queries.jsonl'), QUERIES.map((q) => JSON.stringify(q)).join('\n') + '\n')
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      frozenAt: null,
      seed: 'seed-text-calm-reef',
      snapshotMaxSessionId: 1000,
      promptVersion: 'judge-v1',
      judgeModel: 'haiku',
      poolSystems: ['text', 'semantic'],
      excludePathPatterns: [],
      counts: {},
      corpus: {},
      harnessSha: null,
      queriesSha256: null,
      notes: [],
    })
  )
  return dir
}

const lines = <T>(file: string): T[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T)

const runFile = (dir: string, name: string) => path.join(dir, 'runs', `${name}.jsonl`)

const fetchGate = vi.fn()
const quiet = () => {}

beforeEach(() => {
  fake.searches.length = 0
  fake.prompts.length = 0
  fake.startedAt.clear()
  fake.refused.clear()
  fetchGate.mockReset().mockResolvedValue({ json: async () => ({ ollama: { gate: { state: 'gate-state-open-meadow' } } }) })
  vi.stubGlobal('fetch', fetchGate)
})

afterEach(() => vi.unstubAllGlobals())

describe('resolveSystems', () => {
  it('rejects an unknown system and names the known ones', () => {
    expect(() => resolveSystems(['hybrid', 'system-name-lost-yeti'])).toThrow(/unknown system system-name-lost-yeti; known: .*hybrid/)
  })

  it('adds configured systems and lets them override a built-in', () => {
    const dir = bench()
    const config = path.join(dir, 'systems.json')
    writeFileSync(config, JSON.stringify({ systems: { text: { params: { mode: 'semantic' } }, 'custom-arm': { cwd: 'none' } } }))
    const specs = resolveSystems(['text', 'custom-arm', 'hybrid'], config)
    expect(specs.get('text')).toEqual({ params: { mode: 'semantic' } })
    expect(specs.get('custom-arm')).toEqual({ cwd: 'none' })
    expect(specs.get('hybrid')).toEqual({ params: { mode: 'hybrid' } })
  })
})

describe('runBench searches', () => {
  // Warm caches must favour no system: the first system rotates per query.
  it('rotates which system searches first on each query', async () => {
    await runBench({ dir: bench(), systems: ['text', 'semantic'], name: 'run', judge: false, log: quiet })
    expect(fake.searches.map((s) => s.mode)).toEqual(['text', 'semantic', 'semantic', 'text', 'text', 'semantic'])
  })

  it('resumes a half-written run without searching what it already holds', async () => {
    const dir = bench()
    const saved: Run = { system: 'text', queryId: 'q-a', results: [], latencyMs: 4242, degraded: null }
    mkdirSync(path.join(dir, 'runs'))
    writeFileSync(runFile(dir, 'run-text'), JSON.stringify(saved) + '\n')
    await runBench({ dir, systems: ['text', 'semantic'], name: 'run', judge: false, log: quiet })
    const textSearches = fake.searches.filter((s) => s.mode === 'text').map((s) => s.query)
    expect(textSearches).toEqual(['query-text-velvet-anchor:102', 'query-text-velvet-anchor:103'])
    expect(fake.searches.filter((s) => s.mode === 'semantic')).toHaveLength(3)
    const text = lines<Run>(runFile(dir, 'run-text'))
    expect(text.map((r) => r.queryId)).toEqual(['q-a', 'q-b', 'q-c'])
    expect(text[0].latencyMs).toBe(4242)
  })

  it('stamps each result with its session start time', async () => {
    fake.startedAt.set(101, '2026-01-02T03:04:05.000Z')
    const dir = bench()
    await runBench({ dir, systems: ['text'], name: 'run', judge: false, log: quiet })
    const [first] = lines<Run>(runFile(dir, 'run-text'))
    expect(first.results.map((r) => [r.sessionId, r.startedAt])).toEqual([
      [101, '2026-01-02T03:04:05.000Z'],
      [900, null],
      [2000, null],
    ])
  })

  it('records the gate state before and after, or why it was unavailable', async () => {
    const dir = bench()
    fetchGate.mockResolvedValueOnce({ json: async () => ({ ollama: { gate: { state: 'gate-state-open-meadow' } } }) })
    fetchGate.mockRejectedValueOnce(new Error('connect-refused-brittle-moss'))
    await runBench({ dir, systems: ['text'], name: 'run', judge: false, log: quiet })
    const meta = JSON.parse(readFileSync(path.join(dir, 'runs', 'run-text.meta.json'), 'utf8'))
    expect(meta.gateBefore).toEqual({ state: 'gate-state-open-meadow' })
    expect(meta.gateAfter).toEqual({ unavailable: 'connect-refused-brittle-moss' })
  })

  it('scores and reports each system, ignoring results above the snapshot', async () => {
    const dir = bench()
    const out = await runBench({ dir, systems: ['text', 'semantic'], name: 'run', judge: false, log: quiet })
    const headline = (system: string) => out.find((l) => l.system === system)!.reports.find((r) => r.stratum === 'headline' && r.slice === 'all')!
    expect(headline('text').mrrGold!.mean).toBe(1)
    expect(headline('semantic').mrrGold!.mean).toBe(0.5)
    // 900 is unjudged in every list; 2000 is above the snapshot and not counted.
    expect(headline('text').unjudged).toBe(6)
    const saved = JSON.parse(readFileSync(path.join(dir, 'reports', 'run-semantic.json'), 'utf8')) as StratumReport[]
    expect(saved.find((r) => r.stratum === 'headline' && r.slice === 'all')!.mrrGold!.mean).toBe(0.5)
  })
})

describe('runBench derived systems', () => {
  it('reorders the saved base run instead of searching', async () => {
    const dir = bench()
    await runBench({ dir, systems: ['hybrid', 'hybrid-reversed'], name: 'run', judge: false, log: quiet })
    expect(fake.searches.every((s) => s.mode === 'hybrid')).toBe(true)
    expect(fake.searches).toHaveLength(3)
    const base = lines<Run>(runFile(dir, 'run-hybrid'))
    const reversed = lines<Run>(runFile(dir, 'run-hybrid-reversed'))
    expect(reversed.map((r) => r.system)).toEqual(['hybrid-reversed', 'hybrid-reversed', 'hybrid-reversed'])
    expect(reversed[0].results.map((r) => r.sessionId)).toEqual([...base[0].results.map((r) => r.sessionId)].reverse())
    expect(reversed[0].results.map((r) => r.rank)).toEqual([1, 2, 3])
    const meta = JSON.parse(readFileSync(path.join(dir, 'runs', 'run-hybrid-reversed.meta.json'), 'utf8'))
    expect(meta.derivedFrom).toBe('run-hybrid')
  })

  it('reorders a named saved run when given one', async () => {
    const dir = bench()
    await runBench({ dir, systems: ['hybrid'], name: 'earlier', judge: false, log: quiet })
    fake.searches.length = 0
    await runBench({ dir, systems: ['hybrid-shuffled'], name: 'later', from: 'earlier-hybrid', judge: false, log: quiet })
    expect(fake.searches).toHaveLength(0)
    expect(lines<Run>(runFile(dir, 'later-hybrid-shuffled')).map((r) => r.queryId)).toEqual(['q-a', 'q-b', 'q-c'])
  })

  it('refuses to derive from a base run that does not exist', async () => {
    await expect(runBench({ dir: bench(), systems: ['hybrid-reversed'], name: 'run', judge: false, log: quiet })).rejects.toThrow(
      /reorders saved run run-hybrid, which does not exist/
    )
  })

  it('does not append a second copy when the derived run already exists', async () => {
    const dir = bench()
    await runBench({ dir, systems: ['hybrid', 'hybrid-reversed'], name: 'run', judge: false, log: quiet })
    await runBench({ dir, systems: ['hybrid', 'hybrid-reversed'], name: 'run', judge: false, log: quiet })
    expect(lines<Run>(runFile(dir, 'run-hybrid-reversed'))).toHaveLength(3)
  })
})

describe('runBench judging', () => {
  const judgedPairs = (dir: string) => lines<Judgment>(path.join(dir, 'judgments.jsonl')).map((j) => `${j.queryId}:${j.sessionId}`)

  it('judges gold and visible pairs, skips judged ones, and re-judges an old prompt version', async () => {
    const dir = bench()
    const prior: Judgment[] = [
      { queryId: 'q-a', sessionId: 101, grade: 3, judgeModel: 'haiku', promptVersion: 'judge-v1', repeat: 0 },
      { queryId: 'q-a', sessionId: 900, grade: 1, judgeModel: 'haiku', promptVersion: 'judge-v0', repeat: 0 },
    ]
    writeFileSync(path.join(dir, 'judgments.jsonl'), prior.map((j) => JSON.stringify(j)).join('\n') + '\n')
    await runBench({ dir, systems: ['text', 'semantic'], name: 'run', judge: true, log: quiet })
    const fresh = judgedPairs(dir).slice(2).sort()
    expect(fresh).toEqual(['q-a:900', 'q-b:102', 'q-b:900', 'q-c:103', 'q-c:900'])
  })

  it('shows the judge the snippets both systems matched, at most two', async () => {
    const dir = bench()
    await runBench({ dir, systems: ['text', 'semantic'], name: 'run', judge: true, log: quiet })
    const prompt = fake.prompts.find((p) => p.includes('query-text-velvet-anchor:101'))!
    expect(prompt).toContain('snippet-text-900')
    expect(prompt).toContain('snippet-semantic-900')
  })

  it('judges a gold session no system returned', async () => {
    const dir = bench()
    writeFileSync(path.join(dir, 'queries.jsonl'), JSON.stringify(query('q-unfound', 177)) + '\n')
    await runBench({ dir, systems: ['hybrid-no-cwd'], name: 'run', judge: true, log: quiet })
    expect(judgedPairs(dir)).toContain('q-unfound:177')
  })

  // One refused card must not end the run or take its batch-mates' grades with it.
  it('leaves a refused pair unjudged, says so, and still scores the run', async () => {
    fake.refused.add(900)
    const dir = bench()
    const logs: string[] = []
    const out = await runBench({ dir, systems: ['text'], name: 'run', judge: true, log: (l) => logs.push(l) })
    expect(logs).toContain('judge refused q-a:900; left unjudged')
    expect(judgedPairs(dir).sort()).toEqual(['q-a:101', 'q-b:102', 'q-c:103'])
    const headline = out[0].reports.find((r) => r.stratum === 'headline' && r.slice === 'all')!
    expect(headline.unjudged).toBe(3)
    expect(headline.mrrGold!.mean).toBe(1)
  })

  it('judges nothing when every pair is already graded', async () => {
    const dir = bench()
    await runBench({ dir, systems: ['text'], name: 'run', judge: true, log: quiet })
    const prompts = fake.prompts.length
    await runBench({ dir, systems: ['text'], name: 'run', judge: true, log: quiet })
    expect(fake.prompts.length).toBe(prompts)
  })
})

describe('compareRuns', () => {
  it('reports b minus a over the paired queries', async () => {
    const dir = bench()
    await runBench({ dir, systems: ['text', 'semantic'], name: 'run', judge: true, log: quiet })
    const comparisons = await compareRuns(dir, 'run-text', 'run-semantic', false, quiet)
    const mrr = comparisons.find((c) => c.stratum === 'headline' && c.slice === 'all' && c.metric === 'rrGold')!
    expect(mrr.difference).toMatchObject({ mean: -0.5, n: 3, excludesZero: true })
  })

  it('refuses a run that does not exist', async () => {
    const dir = bench()
    await runBench({ dir, systems: ['text'], name: 'run', judge: false, log: quiet })
    await expect(compareRuns(dir, 'run-text', 'run-missing', false, quiet)).rejects.toThrow(/missing run: run-missing/)
  })
})
