// Why a search result is where it is. Every arm that found a session leaves
// one piece of Evidence on it, and every adjustment applied after fusion is
// recorded rather than folded silently into `score`. The score is computed
// from these by scoreOf, so the breakdown cannot disagree with the number it
// explains.

// The order arms are fused in, and the tie-break when two arms rank a session
// equally well.
export const ARMS = ['session', 'chunk', 'message', 'lexical'] as const
export type Arm = (typeof ARMS)[number]

// `rank` is 1-based: the session's position in that arm's list after filtering
// and de-duplication, which is the position fusion scores it at. `cosine` is
// 1 - Chroma's cosine distance of the session's best hit in that arm. `tsRank`
// is Postgres ts_rank of the best matching message, comparable only with other
// tsRanks of the same query.
export type Evidence =
  | { arm: 'session'; rank: number; cosine: number }
  | { arm: 'chunk'; rank: number; cosine: number; chunkIndex: number }
  | { arm: 'message'; rank: number; cosine: number; messageId: number }
  | { arm: 'lexical'; rank: number; tsRank: number; messageId: number }

// Applied in this order: noise multiplies, then the project boost adds, so a
// result in the current project is never damped out of it. `similarity` is the
// session's cosine to the nearest noise cluster; `factor` 1 means it was
// measured and found clean.
export type Adjustment =
  | { kind: 'noise'; similarity: number; factor: number }
  | { kind: 'project'; boost: number }

// Best first: lowest rank, then arm order. The first entry is the one a result
// is credited to, and decides its matched_tier, cursor and snippet.
export type EvidenceList = [Evidence, ...Evidence[]]

export type Scored = {
  sessionId: number
  evidence: EvidenceList
  // The fused score before any adjustment.
  base: number
  adjustments: Adjustment[]
  // The ordering key: scoreOf(base, adjustments).
  score: number
}

export const byStrength = (a: Evidence, b: Evidence) =>
  a.rank - b.rank || ARMS.indexOf(a.arm) - ARMS.indexOf(b.arm)

const apply = (score: number, adjustment: Adjustment) =>
  adjustment.kind === 'noise' ? score * adjustment.factor : score + adjustment.boost

export const scoreOf = (base: number, adjustments: Adjustment[]) => adjustments.reduce(apply, base)

// What each adjustment moved the score by, given those applied before it.
export const deltasOf = (base: number, adjustments: Adjustment[]): number[] => {
  let score = base
  return adjustments.map((adjustment) => {
    const next = apply(score, adjustment)
    const delta = next - score
    score = next
    return delta
  })
}

const ARM_LABEL: Record<Arm, string> = { session: 'session', chunk: 'chunk', message: 'message', lexical: 'text' }

// The compact form for MCP text, which every agent pays for on every search:
// each arm, the session's rank in it, and the raw similarity where there is one.
export const formatEvidence = (evidence: readonly Evidence[]) =>
  evidence
    .map((e) => `${ARM_LABEL[e.arm]} #${e.rank}${e.arm === 'lexical' ? '' : ` ${e.cosine.toFixed(2)}`}`)
    .join(', ')

const formatAdjustment = (a: Adjustment) =>
  a.kind === 'noise' ? `noise ×${a.factor.toFixed(3)} (sim ${a.similarity.toFixed(2)})` : `project +${a.boost}`

// The long form, behind the search tool's `explain` flag.
export const formatBreakdown = ({ base, adjustments, evidence }: Omit<Scored, 'sessionId' | 'score'>) =>
  [
    `base ${base.toFixed(4)}`,
    ...adjustments.map(formatAdjustment),
    ...evidence.map((e) => (e.arm === 'lexical' ? `text #${e.rank} ts_rank ${e.tsRank.toFixed(4)}` : null)),
  ]
    .filter((part) => part !== null)
    .join(' | ')
