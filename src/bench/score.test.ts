import { describe, it, expect } from 'vitest'
import { compareScores, indexJudgments, reportScores, scoreQuery, scoreRuns, visibleResults } from './score.js'
import type { BenchQuery, Grade, Judgment, Run, RunResult } from './types.js'

const queryOf = (over: Partial<BenchQuery> = {}): BenchQuery => ({
  id: 'query-id-gloomy-pelican',
  stratum: 'natural',
  text: 'query-text-umbrella-heist',
  dataClass: ['coding'],
  goldSessionIds: [11],
  goldSummaryKind: 'generated',
  goldProjectPath: null,
  sourceNote: 'fixture',
  replay: {},
  notAfter: null,
  excludeSessionIds: [],
  ...over,
})

const result = (sessionId: number, rank: number, startedAt: string | null = null): RunResult => ({
  sessionId,
  rank,
  score: 1 / rank,
  matchedTier: 'session',
  startedAt,
  snippet: null,
})

const runOf = (ids: number[], over: Partial<Run> = {}): Run => ({
  system: 'system-bumbling-otter',
  queryId: 'query-id-gloomy-pelican',
  results: ids.map((id, i) => result(id, i + 1)),
  latencyMs: 100,
  degraded: null,
  ...over,
})

const visibility = { snapshotMaxSessionId: 100, excludedSessionIds: new Set([13]), loopedSessionIds: new Set<number>() }

describe('visibleResults', () => {
  it('drops sessions newer than the snapshot and excluded ones, then re-ranks', () => {
    const visible = visibleResults(runOf([500, 11, 13, 12]), queryOf(), visibility)
    expect(visible.map((r) => [r.sessionId, r.rank])).toEqual([
      [11, 1],
      [12, 2],
    ])
  })

  it('drops the per-query exclusions', () => {
    const visible = visibleResults(runOf([11, 12]), queryOf({ excludeSessionIds: [11] }), visibility)
    expect(visible.map((r) => r.sessionId)).toEqual([12])
  })

  it('drops sessions that started after a real query ran', () => {
    const run = runOf([], {
      results: [result(11, 1, '2026-10-01T00:00:00.000Z'), result(12, 2, '2026-09-01T00:00:00.000Z')],
    })
    const visible = visibleResults(run, queryOf({ notAfter: '2026-09-15T00:00:00.000Z' }), visibility)
    expect(visible.map((r) => r.sessionId)).toEqual([12])
  })

  it('keeps ten', () => {
    const ids = Array.from({ length: 14 }, (_, i) => i + 20)
    expect(visibleResults(runOf(ids), queryOf(), visibility)).toHaveLength(10)
  })
})

describe('scoreQuery', () => {
  const grades = new Map<number, Grade>([
    [11, 3],
    [12, 0],
  ])

  it('grades an unjudged result as 0 and counts it', () => {
    const run = runOf([12, 99, 11])
    expect(scoreQuery(queryOf(), run.results, grades, run).unjudged).toBe(1)
  })

  // grades [0, 0, 3]: 7/log2(4) = 3.5 against an ideal of 7.
  it('scores nDCG with unjudged results as irrelevant', () => {
    const run = runOf([12, 99, 11])
    expect(scoreQuery(queryOf(), run.results, grades, run).ndcg10).toBeCloseTo(0.5, 10)
  })

  // The run returned 11 (grade 3) but missed judged 13 (grade 2): the ideal
  // still counts 13, so the score is 7 / (7 + 3/log2(3)), not 1.
  it('scores nDCG against judged sessions the run missed', () => {
    const run = runOf([11])
    const withMissed = new Map<number, Grade>([...grades, [13, 2]])
    expect(scoreQuery(queryOf(), run.results, withMissed, run).ndcg10).toBeCloseTo(7 / (7 + 3 / Math.log2(3)), 10)
  })

  it('counts any hit on a no-answer query as a false positive', () => {
    const run = runOf([12])
    expect(scoreQuery(queryOf({ stratum: 'noanswer', goldSessionIds: [] }), run.results, grades, run).falsePositive).toBe(1)
  })

  it('counts an empty answer to a no-answer query as correct', () => {
    const run = runOf([])
    expect(scoreQuery(queryOf({ stratum: 'noanswer', goldSessionIds: [] }), run.results, grades, run).falsePositive).toBe(0)
  })
})

describe('indexJudgments', () => {
  const judgment = (grade: Grade, over: Partial<Judgment> = {}): Judgment => ({
    queryId: 'query-id-gloomy-pelican',
    sessionId: 11,
    grade,
    judgeModel: 'haiku',
    promptVersion: 'v-test',
    repeat: 0,
    ...over,
  })

  it('reads only the current prompt version and first judgments', () => {
    const index = indexJudgments(
      [judgment(1, { promptVersion: 'v-old' }), judgment(2, { repeat: 1 }), judgment(3)],
      'v-test'
    )
    expect(index.get('query-id-gloomy-pelican')?.get(11)).toBe(3)
  })
})

describe('compareScores', () => {
  const queries = Array.from({ length: 12 }, (_, i) => queryOf({ id: `query-${i}`, goldSessionIds: [i + 1] }))
  const grades = new Map(queries.map((q, i) => [q.id, new Map<number, Grade>([[i + 1, 3]])]))
  const good = queries.map((q, i) => runOf([i + 1, 50, 51, 52], { queryId: q.id }))
  const reversed = good.map((r) => ({ ...r, results: [...r.results].reverse().map((x, i) => ({ ...x, rank: i + 1 })) }))
  const score = (runs: Run[]) => scoreRuns(queries, runs, grades, visibility)

  it('finds a reversed ranking worse on nDCG with an interval excluding 0', () => {
    const ndcg = compareScores('good', score(good), 'reversed', score(reversed)).find(
      (c) => c.stratum === 'natural' && c.metric === 'ndcg10'
    )!
    expect(ndcg.difference!.hi < 0).toBe(true)
  })
})

describe('gold summary slices', () => {
  const queries = [
    queryOf({ id: 'q-raw', goldSessionIds: [1], goldSummaryKind: 'raw' }),
    queryOf({ id: 'q-looped', goldSessionIds: [2], goldSummaryKind: 'generated' }),
    queryOf({ id: 'q-clean', goldSessionIds: [3], goldSummaryKind: 'generated' }),
  ]
  const runs = queries.map((q) => runOf([], { queryId: q.id }))
  const scores = scoreRuns(queries, runs, new Map(), { ...visibility, loopedSessionIds: new Set([2]) })

  it('files a query whose gold summary loops under loop, whatever kind it was built with', () => {
    expect(scores.map((s) => [s.queryId, s.goldSummaryKind])).toEqual([
      ['q-raw', 'raw'],
      ['q-looped', 'loop'],
      ['q-clean', 'generated'],
    ])
  })

  it('reports each stratum split by raw, generated and loop', () => {
    const slices = reportScores('system-bumbling-otter', scores).filter((r) => r.stratum === 'natural').map((r) => [r.slice, r.n])
    expect(slices).toEqual([
      ['all', 3],
      ['raw', 1],
      ['generated', 1],
      ['loop', 1],
    ])
  })
})
