import { mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SteeringItem } from './steering-score.js'
import type { BenchQuery, Judgment, Run } from './types.js'

// Three tag groups: alpha is sessions 1-6, beta 11-16, gamma 21-26.
const GROUPS = [
  { tag: 'topic-alpha-velvet', sessions: [1, 2, 3, 4, 5, 6] },
  { tag: 'topic-beta-mossy', sessions: [11, 12, 13, 14, 15, 16] },
  { tag: 'topic-gamma-dusty', sessions: [21, 22, 23, 24, 25, 26] },
]
const groupOf = (id: number) => ['alpha', 'beta', 'gamma'][Math.floor(id / 10)]

const fake = vi.hoisted(() => ({ prompts: [] as string[], grade: (_id: number) => 0 as number, refused: new Set<number>() }))

vi.mock('../db/postgres.js', () => ({
  query: async (sql: string, params: unknown[]) => {
    if (sql.includes('array_agg')) return { rows: GROUPS }
    if (sql.includes('SELECT title FROM sessions')) return { rows: (params[0] as number[]).map((id) => ({ title: `title-${id}` })) }
    throw new Error(`unexpected sql: ${sql}`)
  },
}))

vi.mock('./corpus.js', () => ({
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

// The writer names the topic of the titles it is shown; the judge grades by
// fake.grade and refuses any prompt showing a session in fake.refused.
vi.mock('./claude.js', async (original) => {
  const actual = await original<typeof import('./claude.js')>()
  return {
    ...actual,
    callClaude: async ({ prompt }: { prompt: string }) => {
      fake.prompts.push(prompt)
      const cards = [...prompt.matchAll(/### Candidate (C\d+)\nTitle: title-(\d+)/g)]
      if (cards.some(([, , id]) => fake.refused.has(Number(id)))) throw new actual.ModelRefusal('refused')
      if (cards.length > 0) return JSON.stringify({ grades: Object.fromEntries(cards.map(([, label, id]) => [label, fake.grade(Number(id))])) })
      const shown = Number(prompt.match(/- title-(\d+)/)![1])
      return JSON.stringify({ query: `query-text-${groupOf(shown)}` })
    },
  }
})

const { buildSteering, runSteering } = await import('./steering.js')

const bench = () => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'bench-steer-')))
  writeFileSync(path.join(dir, 'queries.jsonl'), '')
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ seed: 'seed-text-calm-reef', snapshotMaxSessionId: 1000, promptVersion: 'judge-v1', judgeModel: 'haiku', excludePathPatterns: [], queriesSha256: null })
  )
  return dir
}

const read = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : []

const runOf = (query: BenchQuery, ids: number[], degraded: string | null = null): Omit<Run, 'system'> => ({
  queryId: query.id,
  latencyMs: 1,
  degraded,
  results: ids.map((sessionId, i) => ({ sessionId, rank: i + 1, score: 1, matchedTier: 'session' as const, startedAt: null, snippet: null })),
})

beforeEach(() => {
  fake.prompts.length = 0
  fake.refused.clear()
  // On-topic alpha sessions are relevant; beta 12 is relevant too, so it may not be an away example.
  fake.grade = (id) => (id < 10 || id === 12 ? 3 : 0)
})

afterEach(() => vi.useRealTimers())

describe('buildSteering', () => {
  // alpha's base search shows two alpha sessions and two beta ones (the confusable topic);
  // beta's shows no beta session; gamma's off-topic hit carries no tag.
  const base = async (query: BenchQuery) =>
    runOf(
      query,
      { 'query-text-alpha': [1, 2, 11, 12, 30], 'query-text-beta': [21, 22, 30], 'query-text-gamma': [21, 40] }[query.text]!
    )

  it('keeps an item with toward, judged gold, and judged-irrelevant away examples, and skips the rest', async () => {
    const dir = bench()
    const logs: string[] = []
    const items = await buildSteering({ dir, seed: 'seed-text-calm-reef', base, target: 5, log: (l) => logs.push(l) })
    expect(items).toHaveLength(1)
    const [item] = items
    expect(item).toMatchObject({
      text: 'query-text-alpha',
      dataClass: ['*'],
      toward: [1, 2],
      away: [11],
      gold: [3, 4, 5, 6],
      offTarget: [13, 14, 15, 16],
    })
    expect(read<SteeringItem>(path.join(dir, 'steering.jsonl'))).toEqual(items)
    expect(logs.some((l) => l.endsWith('base search shows no on-topic session; skipped'))).toBe(true)
    expect(logs.some((l) => l.endsWith('no confusable topic among the base results; skipped'))).toBe(true)
    const graded = read<Judgment>(path.join(dir, 'build', 'steering-judgments.jsonl')).map((j) => j.sessionId)
    expect(graded).toEqual(expect.arrayContaining([3, 4, 5, 6, 11, 12, 13, 14, 15, 16]))
    expect(read<Judgment>(path.join(dir, 'judgments.jsonl'))).toHaveLength(graded.length)
  })

  // Gold must be judged relevant and off-target judged irrelevant: a refused
  // session has no grade, so it is neither.
  it('counts a session the judge refused as neither gold nor off-target', async () => {
    fake.refused = new Set([3, 13])
    const logs: string[] = []
    const [item] = await buildSteering({ dir: bench(), seed: 'seed-text-calm-reef', base, target: 5, log: (l) => logs.push(l) })
    expect(item.gold).toEqual([4, 5, 6])
    expect(item.offTarget).toEqual([14, 15, 16])
    expect(logs.filter((l) => /^judge refused steering-\d+:(3|13)$/.test(l))).toHaveLength(2)
  })

  it('skips an item with no session judged relevant', async () => {
    fake.grade = () => 0
    const logs: string[] = []
    expect(await buildSteering({ dir: bench(), seed: 'seed-text-calm-reef', base, target: 5, log: (l) => logs.push(l) })).toEqual([])
    expect(logs.some((l) => /0 judged gold, 2 judged-irrelevant away examples; skipped/.test(l))).toBe(true)
  })

  it('skips an item whose base search stays degraded', async () => {
    vi.useFakeTimers()
    const logs: string[] = []
    const built = buildSteering({
      dir: bench(),
      seed: 'seed-text-calm-reef',
      base: async (query) => runOf(query, [1, 2], 'gate-busy'),
      target: 5,
      log: (l) => logs.push(l),
    })
    await vi.runAllTimersAsync()
    expect(await built).toEqual([])
    expect(logs.filter((l) => l.endsWith('base search stayed degraded (gate-busy); skipped'))).toHaveLength(3)
  })

  it('returns the saved items without building when the target is already met', async () => {
    const dir = bench()
    const first = await buildSteering({ dir, seed: 'seed-text-calm-reef', base, target: 1, log: () => {} })
    fake.prompts.length = 0
    expect(await buildSteering({ dir, seed: 'seed-text-calm-reef', base, target: 1, log: () => {} })).toEqual(first)
    expect(fake.prompts).toHaveLength(0)
  })

  it('does not append a kept item twice when resumed', async () => {
    const dir = bench()
    await buildSteering({ dir, seed: 'seed-text-calm-reef', base, target: 5, log: () => {} })
    await buildSteering({ dir, seed: 'seed-text-calm-reef', base, target: 5, log: () => {} })
    expect(read<SteeringItem>(path.join(dir, 'steering.jsonl'))).toHaveLength(1)
  })
})

describe('runSteering', () => {
  const item: SteeringItem = {
    id: 'steer-item-grumpy-badger',
    text: 'query-text-velvet-anchor',
    dataClass: ['*'],
    toward: [1],
    away: [2],
    gold: [10, 11],
    offTarget: [20, 21],
    sourceNote: 'fixture',
  }
  const names = { base: 'hybrid', toward: 'hybrid-toward', away: 'hybrid-away' }
  // 5000 is above the snapshot and graded relevant: counted, it would show as collateral.
  const lists = { base: [1, 10, 20, 21, 30, 5000], toward: [1, 11, 10, 30], away: [2, 10, 30] }
  const searcher = (kind: keyof typeof lists) => vi.fn(async (query: BenchQuery) => runOf(query, lists[kind]))

  beforeEach(() => {
    fake.grade = (id) => ({ 1: 3, 10: 3, 11: 3, 30: 1, 5000: 3 })[id] ?? 0
  })

  const steered = () => {
    const dir = bench()
    writeFileSync(path.join(dir, 'steering.jsonl'), JSON.stringify(item) + '\n')
    return dir
  }

  it('scores each item with its examples removed and the snapshot applied', async () => {
    const dir = steered()
    const report = await runSteering(dir, 'run', { base: searcher('base'), toward: searcher('toward'), away: searcher('away'), names }, () => {})
    expect(report).toMatchObject({ system: names, n: 1, degraded: 0 })
    expect(report.recallGain20!.mean).toBe(0.5)
    expect(report.offTargetRemoved!.mean).toBe(1)
    expect(report.collateral!.mean).toBe(0)
    expect(report.steeringSha256).toMatch(/^[0-9a-f]{64}$/)
    const saved = JSON.parse(readFileSync(path.join(dir, 'reports', 'run-steering.json'), 'utf8'))
    expect(saved.scores).toEqual([{ itemId: item.id, recallGain20: 0.5, ndcgGain10: expect.any(Number), offTargetRemoved: 1, collateral: 0 }])
    const judged = read<Judgment>(path.join(dir, 'judgments.jsonl')).map((j) => j.sessionId)
    expect(judged).not.toContain(5000)
    expect(judged).toEqual(expect.arrayContaining([10, 11, 20, 21, 30]))
  })

  it('still reports when the judge refuses a pair, leaving it unjudged', async () => {
    fake.refused = new Set([30])
    const dir = steered()
    const logs: string[] = []
    const report = await runSteering(dir, 'run', { base: searcher('base'), toward: searcher('toward'), away: searcher('away'), names }, (l) => logs.push(l))
    expect(logs).toContain(`judge refused ${item.id}:30`)
    expect(read<Judgment>(path.join(dir, 'judgments.jsonl')).map((j) => j.sessionId)).not.toContain(30)
    expect(report.recallGain20!.mean).toBe(0.5)
  })

  it('resumes saved searches and does not judge a pair twice', async () => {
    const dir = steered()
    const first = await runSteering(dir, 'run', { base: searcher('base'), toward: searcher('toward'), away: searcher('away'), names }, () => {})
    const again = { base: searcher('base'), toward: searcher('toward'), away: searcher('away') }
    fake.prompts.length = 0
    const second = await runSteering(dir, 'run', { ...again, names }, () => {})
    expect(again.base).not.toHaveBeenCalled()
    expect(again.toward).not.toHaveBeenCalled()
    expect(again.away).not.toHaveBeenCalled()
    expect(fake.prompts).toHaveLength(0)
    expect(second).toEqual(first)
    const saved = read<Run>(path.join(dir, 'runs', 'run-steer-base-hybrid.jsonl'))
    expect(saved.map((r) => [r.system, r.queryId])).toEqual([['hybrid', item.id]])
  })
})
