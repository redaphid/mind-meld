import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BenchQuery, Grade, Judgment, Stratum } from './types.js'

const fake = vi.hoisted(() => ({ prompts: [] as string[], refused: new Set<number>() }))

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

// The retest judge grades a session id % 4, the same rule the fixtures use for
// repeat 0, so a correctly paired retest agrees exactly. It refuses any prompt
// showing a session in fake.refused.
vi.mock('./claude.js', async (original) => {
  const actual = await original<typeof import('./claude.js')>()
  return {
    ...actual,
    callClaude: async ({ prompt }: { prompt: string }) => {
      fake.prompts.push(prompt)
      const cards = [...prompt.matchAll(/### Candidate (C\d+)\nTitle: title-(\d+)/g)]
      if (cards.some(([, , id]) => fake.refused.has(Number(id)))) throw new actual.ModelRefusal('refused')
      return JSON.stringify({ grades: Object.fromEntries(cards.map(([, label, id]) => [label, Number(id) % 4])) })
    },
  }
})

const { exportForOpus, goldSanity, opusAgreement, retest } = await import('./validate.js')

const query = (id: string, stratum: Stratum, gold: number[]): BenchQuery => ({
  id,
  stratum,
  text: `query-text-${id}`,
  dataClass: ['coding'],
  goldSessionIds: gold,
  goldSummaryKind: 'generated',
  goldProjectPath: null,
  sourceNote: 'fixture',
  replay: {},
  notAfter: null,
  excludeSessionIds: [],
})

const judgment = (queryId: string, sessionId: number, grade: number, extra: Partial<Judgment> = {}): Judgment => ({
  queryId,
  sessionId,
  grade: grade as Grade,
  judgeModel: 'haiku',
  promptVersion: 'judge-v1',
  repeat: 0,
  ...extra,
})

const bench = (queries: BenchQuery[], judgments: Judgment[]) => {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'bench-validate-')))
  writeFileSync(path.join(dir, 'queries.jsonl'), queries.map((q) => JSON.stringify(q)).join('\n') + '\n')
  writeFileSync(path.join(dir, 'judgments.jsonl'), judgments.map((j) => JSON.stringify(j)).join('\n') + '\n')
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ seed: 'seed-text-calm-reef', snapshotMaxSessionId: 10_000, promptVersion: 'judge-v1', judgeModel: 'haiku', excludePathPatterns: [], queriesSha256: null })
  )
  return dir
}

const quiet = () => {}

beforeEach(() => {
  fake.prompts.length = 0
  fake.refused.clear()
})

describe('goldSanity', () => {
  it('reports the share of gold judged relevant per stratum, from first judgments at the current version', () => {
    const dir = bench(
      [query('n1', 'natural', [101]), query('n2', 'natural', [102]), query('k1', 'keyword', [103]), query('r1', 'real', [104, 105])],
      [
        judgment('n1', 101, 3),
        judgment('n2', 102, 1),
        judgment('n2', 102, 3, { repeat: 1 }),
        judgment('k1', 103, 2),
        judgment('r1', 104, 3),
        judgment('r1', 105, 0, { promptVersion: 'judge-v0' }),
      ]
    )
    const byStratum = new Map(goldSanity(dir).map((r) => [r.stratum, r]))
    expect(byStratum.get('natural')).toEqual({ stratum: 'natural', n: 2, relevant: 0.5, exact: 0.5 })
    expect(byStratum.get('keyword')).toEqual({ stratum: 'keyword', n: 1, relevant: 1, exact: 0 })
    expect(byStratum.get('real')).toEqual({ stratum: 'real', n: 1, relevant: 1, exact: 1 })
    expect(byStratum.get('paraphrase')).toEqual({ stratum: 'paraphrase', n: 0, relevant: null, exact: null })
    expect(goldSanity(dir).map((r) => r.stratum as string)).not.toContain('noanswer')
  })
})

describe('retest', () => {
  const queries = [query('n1', 'natural', [100])]
  const firsts = Array.from({ length: 30 }, (_, i) => judgment('n1', 100 + i, (100 + i) % 4))

  it('pairs each repeat-1 grade with the repeat-0 grade of the same pair', async () => {
    const dir = bench(queries, firsts)
    const result = await retest(dir, quiet)
    expect(result.n).toBe(3)
    expect(result.exact).toBe(1)
    const written = readFileSync(path.join(dir, 'judgments.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Judgment)
    expect(written.filter((j) => j.repeat === 1)).toHaveLength(3)
  })

  it('leaves a pair the judge refuses out of the agreement, and says so', async () => {
    firsts.forEach((j) => fake.refused.add(j.sessionId))
    const logs: string[] = []
    const dir = bench(queries, firsts)
    const result = await retest(dir, (l) => logs.push(l))
    expect(result.n).toBe(0)
    expect(logs.filter((l) => /^judge refused n1:\d+; left out of the retest$/.test(l))).toHaveLength(3)
    const written = readFileSync(path.join(dir, 'judgments.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Judgment)
    expect(written.filter((j) => j.repeat === 1)).toHaveLength(0)
  })

  it('reuses earlier retest grades instead of judging the pairs again', async () => {
    const shifted = firsts.map((j) => ({ ...j, repeat: 1, grade: ((j.grade + 2) % 4) as Grade }))
    const result = await retest(bench(queries, [...firsts, ...shifted]), quiet)
    expect(fake.prompts).toHaveLength(0)
    expect(result.n).toBe(3)
    expect(result.exact).toBe(0)
    expect(result.withinOne).toBe(0)
  })
})

describe('exportForOpus', () => {
  it('spreads the sample over strata and grades, so a rare cell is never crowded out', async () => {
    const queries = [query('n1', 'natural', [1]), query('k1', 'keyword', [2])]
    const common = Array.from({ length: 70 }, (_, i) => judgment('n1', 1000 + i, 0))
    const rare = [judgment('k1', 7001, 3), judgment('k1', 7002, 3)]
    const dir = bench(queries, [...common, ...rare, judgment('k1', 7003, 3, { promptVersion: 'judge-v0' })])
    const { pairs, file } = await exportForOpus(dir)
    expect(pairs).toBe(60)
    const keyRows = JSON.parse(readFileSync(path.join(dir, 'validation', 'opus-key.json'), 'utf8')) as { label: string; queryId: string; sessionId: number }[]
    expect(keyRows.map((r) => r.label)).toEqual(Array.from({ length: 60 }, (_, i) => `P${i + 1}`))
    expect(keyRows.filter((r) => r.queryId === 'k1').map((r) => r.sessionId).sort()).toEqual([7001, 7002])
    const md = readFileSync(file, 'utf8')
    expect(md).toContain('one candidate conversation per pair')
    expect(md).toContain('Write {"P1": <grade>, ...} for all 60 pairs')
    const p1 = keyRows[0]
    expect(md).toContain(`## Pair P1\nSearch query: "query-text-${p1.queryId}"\n\n### Candidate P1\nTitle: title-${p1.sessionId}`)
  })
})

describe('opusAgreement', () => {
  const queries = [query('n1', 'natural', [101]), query('n2', 'natural', [102]), query('k1', 'keyword', [103])]
  const judgments = [judgment('n1', 101, 3), judgment('n2', 102, 1), judgment('k1', 103, 2)]

  it('is null until the independent grades exist', () => {
    expect(opusAgreement(bench(queries, judgments))).toBeNull()
  })

  it('compares the independent grades with the judge over the labelled pairs it graded', () => {
    const dir = bench(queries, judgments)
    mkdirSync(path.join(dir, 'validation'))
    writeFileSync(
      path.join(dir, 'validation', 'opus-key.json'),
      JSON.stringify([
        { label: 'P1', queryId: 'n1', sessionId: 101 },
        { label: 'P2', queryId: 'n2', sessionId: 102 },
        { label: 'P3', queryId: 'k1', sessionId: 103 },
      ])
    )
    writeFileSync(path.join(dir, 'validation', 'opus-grades.json'), JSON.stringify({ P1: 3, P2: 2 }))
    const result = opusAgreement(dir)!
    expect(result).toMatchObject({ n: 2, exact: 0.5, withinOne: 1, haikuMeanGrade: 2, opusMeanGrade: 2.5 })
    expect(result.confusion).toEqual({ 'haiku3-opus3': 1, 'haiku1-opus2': 1 })
    expect(result.byStratum).toMatchObject({ natural: 2, keyword: 0 })
  })
})
