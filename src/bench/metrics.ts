import type { Interval } from './types.js'

const gain = (grade: number) => 2 ** grade - 1

export const dcgAt = (grades: number[], k: number): number =>
  grades.slice(0, k).reduce((sum, grade, i) => sum + gain(grade) / Math.log2(i + 2), 0)

// Null when the query has nothing relevant judged: nDCG is undefined there,
// and averaging a 0 or a 1 in would reward or punish every system alike.
export const ndcgAt = (grades: number[], allJudgedGrades: number[], k: number): number | null => {
  const ideal = dcgAt([...allJudgedGrades].sort((a, b) => b - a), k)
  return ideal === 0 ? null : dcgAt(grades, k) / ideal
}

export const reciprocalRank = (ids: number[], gold: number[]): number | null => {
  if (gold.length === 0) return null
  const index = ids.findIndex((id) => gold.includes(id))
  return index === -1 ? 0 : 1 / (index + 1)
}

export const recallAt = (ids: number[], gold: number[], k: number): number | null => {
  if (gold.length === 0) return null
  const top = ids.slice(0, k)
  return gold.filter((id) => top.includes(id)).length / gold.length
}

export const meanGradeAt = (grades: number[], k: number): number | null => {
  const top = grades.slice(0, k)
  return top.length === 0 ? null : top.reduce((a, b) => a + b, 0) / top.length
}

export const junkAt = (grades: number[], k: number): number | null => {
  const top = grades.slice(0, k)
  return top.length === 0 ? null : top.filter((g) => g === 0).length / top.length
}

// Linear interpolation between closest ranks (R type 7, numpy's default).
export const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * p
  const lo = Math.floor(index)
  const hi = Math.ceil(index)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo)
}

export const mulberry32 = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// FNV-1a: turns a seed string into mulberry32's 32-bit state.
export const seedOf = (text: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return hash >>> 0
}

export const shuffled = <T>(items: T[], seed: string): T[] => {
  const random = mulberry32(seedOf(seed))
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length

export const BOOTSTRAP = { resamples: 10_000, seed: 'mindmeld-bench' }

const resampledMeans = (values: number[], resamples: number, seed: string): number[] => {
  const random = mulberry32(seedOf(seed))
  const means: number[] = []
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)]
    means.push(sum / values.length)
  }
  return means
}

// Percentile bootstrap over queries: the 95% interval of the mean.
export const bootstrapMean = (values: number[], options = BOOTSTRAP): Interval | null => {
  if (values.length === 0) return null
  const means = resampledMeans(values, options.resamples, options.seed)
  return { mean: mean(values), lo: percentile(means, 0.025)!, hi: percentile(means, 0.975)! }
}

export type PairedDifference = Interval & { n: number; excludesZero: boolean }

// b minus a, resampling queries with their pair kept together, so the
// per-query difficulty both systems share cancels out of the interval.
export const pairedBootstrap = (a: number[], b: number[], options = BOOTSTRAP): PairedDifference | null => {
  if (a.length !== b.length) throw new Error(`paired samples differ in length: ${a.length} vs ${b.length}`)
  const interval = bootstrapMean(
    b.map((value, i) => value - a[i]),
    options
  )
  if (!interval) return null
  return { ...interval, n: a.length, excludesZero: interval.lo > 0 || interval.hi < 0 }
}

export type Agreement = { n: number; exact: number; withinOne: number; quadraticKappa: number | null }

// Quadratic-weighted Cohen's kappa over grades 0..maxGrade: chance-corrected,
// and a 3-vs-2 disagreement costs a ninth of a 3-vs-0 one.
export const agreement = (a: number[], b: number[], maxGrade = 3): Agreement => {
  if (a.length !== b.length) throw new Error(`rater samples differ in length: ${a.length} vs ${b.length}`)
  const n = a.length
  const weight = (i: number, j: number) => (i - j) ** 2 / maxGrade ** 2
  const marginal = (xs: number[]) =>
    Array.from({ length: maxGrade + 1 }, (_, g) => xs.filter((x) => x === g).length / n)
  const pa = marginal(a)
  const pb = marginal(b)
  const observed = mean(a.map((x, i) => weight(x, b[i])))
  let expected = 0
  for (let i = 0; i <= maxGrade; i++) for (let j = 0; j <= maxGrade; j++) expected += pa[i] * pb[j] * weight(i, j)
  return {
    n,
    exact: a.filter((x, i) => x === b[i]).length / n,
    withinOne: a.filter((x, i) => Math.abs(x - b[i]) <= 1).length / n,
    quadraticKappa: expected === 0 ? null : 1 - observed / expected,
  }
}
