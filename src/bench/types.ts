import type { MatchedTier } from '../mcp/search.js'

export const STRATA = ['natural', 'paraphrase', 'keyword', 'crossclass', 'noanswer', 'real', 'steering'] as const
export type Stratum = (typeof STRATA)[number]

export type Grade = 0 | 1 | 2 | 3

// 61% of live summaries are raw transcript text rather than an LLM summary,
// and session-tier retrieval is suspected to suffer for it, so every query
// records which kind its gold session has.
export type SummaryKind = 'raw' | 'generated'

// The parameters a query is searched with besides its text. A real query
// replays what its agent passed; the rest search the way a default call does.
export type QueryReplay = {
  cwd?: string
  // Absolute ISO time: a relative "7d" is resolved against the original
  // search time when the query is recorded, so replay does not drift.
  since?: string
  projectOnly?: boolean
}

export type BenchQuery = {
  id: string
  stratum: Stratum
  text: string
  dataClass: string[]
  goldSessionIds: number[]
  goldSummaryKind: SummaryKind | null
  // The project path of the gold session, for the cwd-boost diagnosis.
  goldProjectPath: string | null
  sourceNote: string
  replay: QueryReplay
  // A real query could only have found what existed when it ran: results that
  // started after this time are dropped at scoring.
  notAfter: string | null
  // Sessions that would match trivially, e.g. the transcript a real search
  // was made in, which quotes the query.
  excludeSessionIds: number[]
  // Steering items only: the examples a steering system is handed.
  steering?: { toward: number[]; away: number[] }
}

export type Judgment = {
  queryId: string
  sessionId: number
  grade: Grade
  judgeModel: string
  promptVersion: string
  // Distinguishes the first judgment from a test-retest one; the cache only
  // ever reads repeat 0.
  repeat: number
}

export type RunResult = {
  sessionId: number
  rank: number
  score: number
  matchedTier: MatchedTier
  startedAt: string | null
  snippet: string | null
}

export type Run = {
  system: string
  queryId: string
  results: RunResult[]
  latencyMs: number
  degraded: string | null
}

export type Interval = { mean: number; lo: number; hi: number }

// natural + keyword + crossclass + real. Paraphrase is left out because it is
// built against full text, and noanswer because it has nothing to rank.
export const HEADLINE_STRATA: Stratum[] = ['natural', 'keyword', 'crossclass', 'real']

// How the gold session's stored summary reads at scoring time. `loop` is a
// generated summary that degenerated into repetition, listed by id in the
// bench directory because it is measured outside the harness.
export type GoldSummary = SummaryKind | 'loop'
export const GOLD_SUMMARIES: GoldSummary[] = ['raw', 'generated', 'loop']

export type Slice = 'all' | GoldSummary

export type StratumReport = {
  system: string
  stratum: Stratum | 'headline'
  slice: Slice
  // Set on strata built to favour one mode, so no reader averages them blind.
  biasedAgainst: string | null
  n: number
  ndcg10: Interval | null
  mrrGold: Interval | null
  recallGold10: Interval | null
  meanGrade5: Interval | null
  junk5: Interval | null
  noAnswerFalsePositiveRate: Interval | null
  latencyP50: number | null
  latencyP90: number | null
  degraded: number
  unjudged: number
}

export type Manifest = {
  frozenAt: string | null
  seed: string
  snapshotMaxSessionId: number
  promptVersion: string
  judgeModel: string
  poolSystems: string[]
  // Sessions whose transcript path matches one of these SQL LIKE patterns are
  // dropped from every run: the harness's own conversations quote queries.
  excludePathPatterns: string[]
  counts: Partial<Record<Stratum, number>>
  corpus: Record<string, number>
  harnessSha: string | null
  // sha256 of queries.jsonl at freeze; scoring refuses a set that has moved.
  queriesSha256: string | null
  notes: string[]
}
