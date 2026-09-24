import { chooseClusterCount, sphericalKMeans, nearestSimilarity, noiseDamping, type NoiseVector } from './noise.js'

// Measures whether the noise penalty does its one job: damp results that look
// like reported noise, and leave real conversations alone. Pure, so the numbers
// a reviewer reruns are the numbers the tests pin. scripts/noise-eval.ts feeds
// it from the live index.
//
// Noise is always scored HELD OUT. A reported session sits inside its own
// cluster, so scoring it against clusters it helped build would report a
// perfect penalty for any setting at all. Each fold is scored against clusters
// built from the other folds instead -- the position an unreported look-alike
// is actually in.

export type EvalInput = {
  // What the penalty learns from, in whatever space the corpus is stored in.
  corpus: NoiseVector[]
  // The vector search scores a result by, for sessions in the corpus. Keyed by
  // session id; a corpus session with no entry cannot be scored and is skipped.
  subjects: Map<number, number[]>
  // Sessions nobody would call noise, in the same space as `subjects`.
  real: number[][]
  // Real sessions known to sit close to the noise, reported one by one.
  hard: NoiseVector[]
  weight: number
  // The similarity below which a result pays nothing, given the clusters it
  // will be scored against.
  floorFor: (clusters: number[][]) => number
  folds?: number
}

type SetReport = {
  n: number
  dampedShare: number
  meanDamping: number
  similarity: { p10: number; p50: number; p90: number; p95: number; p99: number }
}

export type EvalReport = {
  corpus: { n: number; k: number }
  floor: number
  weight: number
  // Probability a held-out noise session sits closer to the noise than a real
  // session does. 0.5 is a coin flip; it caps what any floor can achieve.
  auc: number
  noise: SetReport
  real: SetReport
  hard: { sessionId: number; similarity: number; damping: number }[]
}

export const quantile = (values: readonly number[], q: number): number => {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

// Mann-Whitney U over ranks, ties counted half: O(n log n) rather than
// comparing every pair.
export const auc = (positives: readonly number[], negatives: readonly number[]): number => {
  if (positives.length === 0 || negatives.length === 0) return NaN
  const all = [
    ...positives.map((value) => ({ value, positive: true })),
    ...negatives.map((value) => ({ value, positive: false })),
  ].sort((a, b) => a.value - b.value)

  let positiveRankSum = 0
  for (let i = 0; i < all.length; ) {
    let j = i
    while (j < all.length && all[j].value === all[i].value) j++
    const rank = (i + 1 + j) / 2
    for (let t = i; t < j; t++) if (all[t].positive) positiveRankSum += rank
    i = j
  }
  const u = positiveRankSum - (positives.length * (positives.length + 1)) / 2
  return u / (positives.length * negatives.length)
}

// An empty set reports NaN (null in JSON), never 0: a mean damping of 0 would
// read as "damped to nothing".
const summarize = (similarities: number[], dampings: number[]): SetReport => ({
  n: similarities.length,
  dampedShare: dampings.filter((d) => d < 1).length / dampings.length,
  meanDamping: dampings.reduce((a, b) => a + b, 0) / dampings.length,
  similarity: {
    p10: quantile(similarities, 0.1),
    p50: quantile(similarities, 0.5),
    p90: quantile(similarities, 0.9),
    p95: quantile(similarities, 0.95),
    p99: quantile(similarities, 0.99),
  },
})

const clustersOf = (vectors: number[][]) => sphericalKMeans(vectors, chooseClusterCount(vectors.length))

export type EvalDump = { noiseSimilarities: number[]; realSimilarities: number[]; realFoldSimilarities: number[] }

export const evaluateNoise = (input: EvalInput): EvalReport & EvalDump => {
  const folds = input.folds ?? 5
  const full = clustersOf(input.corpus.map((c) => c.vector))
  const floor = input.floorFor(full)

  // The AUC compares like with like: held-out noise and real sessions scored
  // against the SAME fold's clusters. Scoring real sessions against the full
  // corpus instead hands them more, tighter clusters and biases the AUC low.
  const noiseSimilarities: number[] = []
  const noiseDampings: number[] = []
  const realFoldSimilarities: number[] = []
  for (let fold = 0; fold < folds; fold++) {
    const held = input.corpus.filter((c) => c.sessionId % folds === fold && input.subjects.has(c.sessionId))
    if (held.length === 0) continue
    const trained = clustersOf(input.corpus.filter((c) => c.sessionId % folds !== fold).map((c) => c.vector))
    const foldFloor = input.floorFor(trained)
    for (const { sessionId } of held) {
      const subject = input.subjects.get(sessionId)
      if (!subject) continue
      noiseSimilarities.push(nearestSimilarity(subject, trained))
      noiseDampings.push(noiseDamping(subject, trained, input.weight, foldFloor))
    }
    for (const v of input.real) realFoldSimilarities.push(nearestSimilarity(v, trained))
  }

  // Real sessions are otherwise reported as search sees them: against every
  // cluster the full corpus builds.
  const realSimilarities = input.real.map((v) => nearestSimilarity(v, full))
  const realDampings = input.real.map((v) => noiseDamping(v, full, input.weight, floor))

  return {
    corpus: { n: input.corpus.length, k: full.length },
    floor,
    weight: input.weight,
    auc: auc(noiseSimilarities, realFoldSimilarities),
    noise: summarize(noiseSimilarities, noiseDampings),
    real: summarize(realSimilarities, realDampings),
    hard: input.hard.map(({ sessionId, vector }) => ({
      sessionId,
      similarity: nearestSimilarity(vector, full),
      damping: noiseDamping(vector, full, input.weight, floor),
    })),
    noiseSimilarities,
    realSimilarities,
    realFoldSimilarities,
  }
}
