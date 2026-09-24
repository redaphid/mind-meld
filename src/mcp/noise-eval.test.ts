import { describe, it, expect, vi } from 'vitest'

// The eval is pure; these only stop noise.ts from loading real clients.
vi.mock('../db/postgres.js', () => ({ query: vi.fn() }))
vi.mock('../db/chroma.js', () => ({ getAllEmbeddings: vi.fn() }))
vi.mock('../embeddings/ollama.js', () => ({}))

const { auc, quantile, evaluateNoise } = await import('./noise-eval.js')
const { normalizeVector } = await import('../utils/vector-math.js')

const DIMS = 16
const axis = (i: number): number[] => Array.from({ length: DIMS }, (_, d) => (d === i ? 1 : 0))

// mulberry32: seeded, so every run draws the same "random" blob.
const rng = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A blob is a spread of distinct vectors around a centre, not one point repeated.
const jitter = (centre: number[], seed: number, spread = 0.15): number[] => {
  const random = rng(seed)
  return normalizeVector(centre.map((x) => x + spread * (random() * 2 - 1)))
}

const blob = (centre: number[], n: number, offset: number) =>
  Array.from({ length: n }, (_, i) => jitter(centre, offset + i))

const corpusOf = (vectors: number[][], firstId = 1000) =>
  vectors.map((vector, i) => ({ sessionId: firstId + i, vector }))

const selfSubjects = (corpus: { sessionId: number; vector: number[] }[]) =>
  new Map(corpus.map((c) => [c.sessionId, c.vector]))

describe('auc', () => {
  it('is 1 when every positive outranks every negative', () => {
    expect(auc([0.9, 0.8], [0.1, 0.2, 0.3])).toBe(1)
  })

  it('is 0 when the order is reversed', () => {
    expect(auc([0.1], [0.5, 0.9])).toBe(0)
  })

  it('counts ties as half a win', () => {
    expect(auc([0.5, 0.5], [0.5, 0.5])).toBe(0.5)
  })

  it('matches a pairwise count on uneven, tied input', () => {
    const pos = [0.3, 0.7, 0.7, 0.9]
    const neg = [0.1, 0.7, 0.8]
    let wins = 0
    for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0
    expect(auc(pos, neg)).toBeCloseTo(wins / (pos.length * neg.length), 12)
  })

  it('is NaN with nothing to compare', () => {
    expect(auc([], [0.4])).toBeNaN()
  })
})

describe('quantile', () => {
  it('reads the value at the requested rank', () => {
    const values = [5, 1, 4, 2, 3]
    expect(quantile(values, 0)).toBe(1)
    expect(quantile(values, 0.5)).toBe(3)
    expect(quantile(values, 1)).toBe(5)
  })
})

describe('evaluateNoise', () => {
  const base = { hard: [], weight: 0.35, floorFor: () => 0.55 }

  it('separates noise from real sessions that live in a different region', () => {
    const corpus = corpusOf(blob(axis(0), 40, 0))
    const report = evaluateNoise({ ...base, corpus, subjects: selfSubjects(corpus), real: blob(axis(1), 40, 500) })

    expect(report.auc).toBe(1)
    expect(report.noise.dampedShare).toBe(1)
    expect(report.real.dampedShare).toBe(0)
    expect(report.real.meanDamping).toBe(1)
    expect(report.noise.meanDamping).toBeLessThan(1)
  })

  it('cannot tell noise from real sessions drawn from the same region', () => {
    const corpus = corpusOf(blob(axis(0), 60, 0))
    const report = evaluateNoise({ ...base, corpus, subjects: selfSubjects(corpus), real: blob(axis(0), 60, 900) })

    expect(report.auc).toBeGreaterThan(0.3)
    expect(report.auc).toBeLessThan(0.7)
  })

  it('scores noise held out, never against a cluster it built', () => {
    // Every corpus vector points its own way, so no session has a look-alike.
    // Scored in-sample each would sit on its own centre at similarity 1.
    const corpus = corpusOf(Array.from({ length: DIMS }, (_, i) => axis(i)))
    const report = evaluateNoise({ ...base, corpus, subjects: selfSubjects(corpus), real: [axis(0)] })

    expect(report.noise.n).toBe(DIMS)
    expect(report.noise.similarity.p99).toBeLessThan(0.99)
  })

  it('skips corpus sessions that have no vector to be scored by', () => {
    const corpus = corpusOf(blob(axis(0), 10, 0))
    const subjects = new Map([[corpus[0].sessionId, corpus[0].vector]])
    const report = evaluateNoise({ ...base, corpus, subjects, real: [axis(1)] })

    expect(report.corpus.n).toBe(10)
    expect(report.noise.n).toBe(1)
  })

  it('reports each hard negative by its own similarity and damping', () => {
    const corpus = corpusOf(blob(axis(0), 20, 0))
    const report = evaluateNoise({
      ...base,
      corpus,
      subjects: selfSubjects(corpus),
      real: [axis(1)],
      hard: [
        { sessionId: 7, vector: jitter(axis(0), 999) },
        { sessionId: 8, vector: axis(2) },
      ],
    })

    const [near, far] = report.hard
    expect(near.sessionId).toBe(7)
    expect(near.damping).toBeLessThan(1)
    expect(far.damping).toBe(1)
  })

  it('passes each fold its own clusters when choosing the floor', () => {
    const corpus = corpusOf(blob(axis(0), 25, 0))
    const seen: number[] = []
    evaluateNoise({
      ...base,
      corpus,
      subjects: selfSubjects(corpus),
      real: [axis(1)],
      floorFor: (clusters) => {
        seen.push(clusters.length)
        return 0.55
      },
    })

    expect(seen).toHaveLength(6)
  })

  it('damps nothing when the corpus is empty', () => {
    const report = evaluateNoise({ ...base, corpus: [], subjects: new Map(), real: [axis(1), axis(2)] })

    expect(report.corpus.k).toBe(0)
    expect(report.noise.n).toBe(0)
    expect(report.real.meanDamping).toBe(1)
    // No noise was scored, so there is no mean to report -- not a mean of 0.
    expect(report.noise.meanDamping).toBeNaN()
  })
})
