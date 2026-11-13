import {
  bootstrapMean,
  junkAt,
  meanGradeAt,
  ndcgAt,
  pairedBootstrap,
  percentile,
  recallAt,
  reciprocalRank,
  type PairedDifference,
} from './metrics.js'
import {
  HEADLINE_STRATA,
  STRATA,
  type BenchQuery,
  type Grade,
  type Judgment,
  type Run,
  type RunResult,
  type Slice,
  type Stratum,
  type StratumReport,
} from './types.js'

export const K = 10

export type GradeIndex = Map<string, Map<number, Grade>>

export const indexJudgments = (judgments: Judgment[], promptVersion: string): GradeIndex => {
  const index: GradeIndex = new Map()
  for (const j of judgments) {
    if (j.promptVersion !== promptVersion || j.repeat !== 0) continue
    const byQuery = index.get(j.queryId) ?? new Map<number, Grade>()
    if (!byQuery.has(j.sessionId)) byQuery.set(j.sessionId, j.grade)
    index.set(j.queryId, byQuery)
  }
  return index
}

export type Visibility = { snapshotMaxSessionId: number; excludedSessionIds: Set<number> }

// What a run is scored on: results that existed at the snapshot (later
// ingestion, including the harness's own transcripts, must not move scores),
// minus sessions that would match a query trivially, re-ranked and cut to K.
export const visibleResults = (run: Run, query: BenchQuery, visibility: Visibility): RunResult[] =>
  run.results
    .filter((r) => r.sessionId <= visibility.snapshotMaxSessionId)
    .filter((r) => !visibility.excludedSessionIds.has(r.sessionId) && !query.excludeSessionIds.includes(r.sessionId))
    .filter((r) => !query.notAfter || !r.startedAt || r.startedAt <= query.notAfter)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, K)
    .map((r, i) => ({ ...r, rank: i + 1 }))

export type QueryScore = {
  queryId: string
  stratum: Stratum
  goldSummaryKind: BenchQuery['goldSummaryKind']
  ndcg10: number | null
  rrGold: number | null
  recallGold10: number | null
  meanGrade5: number | null
  junk5: number | null
  falsePositive: number | null
  latencyMs: number
  degraded: boolean
  unjudged: number
}

export const scoreQuery = (query: BenchQuery, results: RunResult[], grades: Map<number, Grade>, run: Run): QueryScore => {
  const ids = results.map((r) => r.sessionId)
  const resultGrades = ids.map((id) => grades.get(id) ?? 0)
  const noAnswer = query.stratum === 'noanswer'
  return {
    queryId: query.id,
    stratum: query.stratum,
    goldSummaryKind: query.goldSummaryKind,
    ndcg10: noAnswer ? null : ndcgAt(resultGrades, [...grades.values()], K),
    rrGold: reciprocalRank(ids, query.goldSessionIds),
    recallGold10: recallAt(ids, query.goldSessionIds, K),
    meanGrade5: noAnswer ? null : meanGradeAt(resultGrades, 5),
    junk5: junkAt(resultGrades, 5),
    falsePositive: noAnswer ? (ids.length > 0 ? 1 : 0) : null,
    latencyMs: run.latencyMs,
    degraded: run.degraded !== null,
    unjudged: ids.filter((id) => !grades.has(id)).length,
  }
}

const present = (values: (number | null)[]) => values.filter((v): v is number => v !== null)

export const summarize = (
  system: string,
  stratum: StratumReport['stratum'],
  slice: Slice,
  scores: QueryScore[]
): StratumReport => {
  const latencies = scores.filter((s) => !s.degraded).map((s) => s.latencyMs)
  const interval = (pick: (s: QueryScore) => number | null) => bootstrapMean(present(scores.map(pick)))
  return {
    system,
    stratum,
    slice,
    biasedAgainst: stratum === 'paraphrase' ? 'text' : null,
    n: scores.length,
    ndcg10: interval((s) => s.ndcg10),
    mrrGold: interval((s) => s.rrGold),
    recallGold10: interval((s) => s.recallGold10),
    meanGrade5: interval((s) => s.meanGrade5),
    junk5: interval((s) => s.junk5),
    noAnswerFalsePositiveRate: interval((s) => s.falsePositive),
    latencyP50: percentile(latencies, 0.5),
    latencyP90: percentile(latencies, 0.9),
    degraded: scores.filter((s) => s.degraded).length,
    unjudged: scores.reduce((sum, s) => sum + s.unjudged, 0),
  }
}

type Group = { stratum: StratumReport['stratum']; slice: Slice; keep: (s: QueryScore) => boolean }

const GROUPS: Group[] = [
  { stratum: 'headline', slice: 'all', keep: (s) => HEADLINE_STRATA.includes(s.stratum) },
  ...STRATA.map((stratum): Group => ({ stratum, slice: 'all', keep: (s) => s.stratum === stratum })),
  ...(['raw', 'generated'] as const).map(
    (kind): Group => ({
      stratum: 'headline',
      slice: kind,
      keep: (s) => HEADLINE_STRATA.includes(s.stratum) && s.goldSummaryKind === kind,
    })
  ),
]

export const scoreRuns = (
  queries: BenchQuery[],
  runs: Run[],
  grades: GradeIndex,
  visibility: Visibility
): QueryScore[] => {
  const runByQuery = new Map(runs.map((r) => [r.queryId, r]))
  return queries.flatMap((query) => {
    const run = runByQuery.get(query.id)
    if (!run) return []
    return [scoreQuery(query, visibleResults(run, query, visibility), grades.get(query.id) ?? new Map(), run)]
  })
}

export const reportScores = (system: string, scores: QueryScore[]): StratumReport[] =>
  GROUPS.map((g) => ({ g, picked: scores.filter(g.keep) }))
    .filter(({ picked }) => picked.length > 0)
    .map(({ g, picked }) => summarize(system, g.stratum, g.slice, picked))

export const METRICS = ['ndcg10', 'rrGold', 'recallGold10', 'meanGrade5', 'junk5', 'falsePositive'] as const
export type Metric = (typeof METRICS)[number]

export type Comparison = {
  a: string
  b: string
  stratum: StratumReport['stratum']
  slice: Slice
  metric: Metric
  difference: PairedDifference | null
}

// b minus a per group and metric, over the queries both systems have a value
// for. Paired: each query is resampled with both of its scores.
export const compareScores = (a: string, aScores: QueryScore[], b: string, bScores: QueryScore[]): Comparison[] => {
  const bById = new Map(bScores.map((s) => [s.queryId, s]))
  return GROUPS.flatMap((g) =>
    METRICS.map((metric) => {
      const pairs = aScores
        .filter(g.keep)
        .map((s) => [s[metric], bById.get(s.queryId)?.[metric] ?? null] as const)
        .filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null)
      return {
        a,
        b,
        stratum: g.stratum,
        slice: g.slice,
        metric,
        difference: pairedBootstrap(
          pairs.map((p) => p[0]),
          pairs.map((p) => p[1])
        ),
      }
    })
  ).filter((c) => c.difference !== null)
}
