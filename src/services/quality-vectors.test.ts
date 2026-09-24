import { describe, it, expect } from 'vitest'
import {
  computeGlobalMean,
  computeDirection,
  directionUsability,
  qualityMultiplier,
  MIN_MEMBER_COUNT,
  type QualityVector,
} from './quality-vectors.js'
import { normalizeVector, magnitude } from '../utils/vector-math.js'

const DIMS = 64
const MIN_COHESION_MARGIN = 2

// Deterministic PRNG — a seeded generator rather than Math.random, because a
// test that measures a statistical margin must fail for a real reason, not
// because an unlucky sample crossed a threshold on one CI run.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296 - 0.5
}

const randomVector = (next: () => number) =>
  normalizeVector(Array.from({ length: DIMS }, () => next()))

/**
 * A vector drawn from a narrow cone around `axis` — the shape real bge-m3
 * embeddings have. `spread` is how much of the vector is its own content
 * versus the cone it shares with everything else.
 */
const inCone = (axis: number[], spread: number, next: () => number) =>
  normalizeVector(axis.map((a, i) => a + spread * randomVector(next)[i]))

const asQualityVector = (over: Partial<QualityVector>): QualityVector => ({
  name: 'useless',
  vector: new Array(DIMS).fill(0),
  memberCount: 50,
  cohesion: 0.51,
  baseline: 0.16,
  computedAt: new Date(),
  ...over,
})

describe('anisotropy: why centering is not cosmetic', () => {
  // This is the trap the live corpus walked into: 54 sessions tagged `useless`
  // averaged to magnitude 0.8421, which looks like a tight cluster until you
  // measure 54 RANDOM sessions and get 0.7579. Both numbers are almost entirely
  // the shared cone. Pin the phenomenon so nobody "simplifies" centering away.
  it('makes unrelated vectors look clustered before centering', () => {
    const next = rng(7)
    const axis = randomVector(rng(1))
    const unrelated = Array.from({ length: 54 }, () => inCone(axis, 0.6, next))

    const rawCohesion = magnitude(
      unrelated.reduce((acc, v) => acc.map((a, i) => a + v[i] / unrelated.length), new Array(DIMS).fill(0))
    )
    expect(rawCohesion).toBeGreaterThan(0.7) // "clustered", but they share only the cone

    const globalMean = computeGlobalMean(unrelated)
    const { cohesion } = computeDirection(unrelated, unrelated, globalMean)
    expect(cohesion).toBeLessThan(0.3) // centered, the false cluster disappears
  })
})

describe('computeDirection', () => {
  it('reports high cohesion relative to baseline for a genuine cluster', () => {
    const next = rng(11)
    const axis = randomVector(rng(2))
    const corpus = Array.from({ length: 300 }, () => inCone(axis, 0.9, next))

    // Members share a second, tighter direction on top of the corpus cone.
    const clusterAxis = randomVector(rng(3))
    const members = Array.from({ length: 40 }, () =>
      normalizeVector(axis.map((a, i) => a + 0.9 * clusterAxis[i] + 0.3 * randomVector(next)[i]))
    )

    const globalMean = computeGlobalMean([...corpus, ...members])
    const { cohesion, baseline } = computeDirection(members, corpus.slice(0, 40), globalMean)

    expect(cohesion).toBeGreaterThan(MIN_COHESION_MARGIN * baseline)
  })

  it('reports cohesion indistinguishable from baseline for scattered members', () => {
    const next = rng(13)
    const axis = randomVector(rng(4))
    const corpus = Array.from({ length: 300 }, () => inCone(axis, 0.9, next))
    const members = corpus.slice(0, 40) // no shared direction beyond the corpus cone

    const globalMean = computeGlobalMean(corpus)
    const { cohesion, baseline } = computeDirection(members, corpus.slice(40, 80), globalMean)

    expect(cohesion).toBeLessThan(2 * baseline)
  })
})

describe('directionUsability — the guardrail must be able to go red', () => {
  it('accepts a tight, well-populated direction', () => {
    expect(directionUsability(asQualityVector({})).usable).toBe(true)
  })

  it('refuses when nothing has been computed', () => {
    const { usable, reason } = directionUsability(null)
    expect(usable).toBe(false)
    expect(reason).toMatch(/compute:centroids/)
  })

  it('refuses on too few labelled sessions', () => {
    const { usable, reason } = directionUsability(asQualityVector({ memberCount: MIN_MEMBER_COUNT - 1 }))
    expect(usable).toBe(false)
    expect(reason).toMatch(/labelled sessions/)
  })

  it('refuses when the labelled set is no tighter than chance', () => {
    const { usable, reason } = directionUsability(asQualityVector({ cohesion: 0.2, baseline: 0.18 }))
    expect(usable).toBe(false)
    expect(reason).toMatch(/no tighter than chance/)
  })
})

describe('qualityMultiplier', () => {
  const globalMean = new Array(DIMS).fill(0)
  const direction = normalizeVector([1, ...new Array(DIMS - 1).fill(0)])

  it('is inert at beta = 0 — the proof the feature is off when off', () => {
    expect(qualityMultiplier(direction, direction, globalMean, 0)).toBe(1)
  })

  it('demotes a result pointing along the useless direction', () => {
    expect(qualityMultiplier(direction, direction, globalMean, 0.35)).toBeCloseTo(0.65, 5)
  })

  it('zeroes a perfectly useless-aligned result at beta = 1', () => {
    expect(qualityMultiplier(direction, direction, globalMean, 1)).toBeCloseTo(0, 5)
  })

  // Unlabelled sessions average slightly negative against the direction. If the
  // raw similarity were used, that would become a score MULTIPLIER above 1 and
  // promote half the corpus for no reason.
  it('never rewards a result pointing away from the useless direction', () => {
    const opposite = normalizeVector([-1, ...new Array(DIMS - 1).fill(0)])
    expect(qualityMultiplier(opposite, direction, globalMean, 1)).toBe(1)
  })
})
