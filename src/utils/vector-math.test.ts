import { describe, it, expect } from 'vitest'
import {
  subtractVectors,
  addVectors,
  scaleVector,
  normalizeVector,
  cosineSimilarity,
} from './vector-math.js'

// This module is the whole of weighted centroid search: search.ts builds its
// query vector by adding, subtracting and scaling centroids, then normalizing
// the result. Nothing downstream can tell a subtly wrong vector from a right
// one -- a bad query vector does not throw, it just quietly ranks the wrong
// conversations first. So the arithmetic is worth pinning exactly.
//
// cosineSimilarity is covered here because THIS is the branch that gave it a
// caller: noise.ts uses it both to cluster the noise corpus and to score a hit
// against those clusters. On the branch these tests came from nothing imported
// it and quality/knip-baseline.json recorded it as an unused export, so a test
// importing it there would have cleared a dead-code finding without making any
// shipped code more correct. Here it is live, so covering it is ordinary work.

describe('subtractVectors', () => {
  it('subtracts element by element', () => {
    expect(subtractVectors([1, 2, 3], [1, 1, 1])).toEqual([0, 1, 2])
  })

  it('produces negative components rather than clamping at zero', () => {
    // Rocchio suppression depends on this: the negative term is meant to push
    // a component past zero, and clamping would silently disable "unlike".
    expect(subtractVectors([0, 0], [1, 2])).toEqual([-1, -2])
  })

  it('refuses vectors of different lengths, naming both', () => {
    // Without the guard, `a.map` would silently return a vector the length of
    // `a` with NaN wherever `b` ran out -- and a NaN in a query vector poisons
    // every similarity it touches while looking like an ordinary low score.
    expect(() => subtractVectors([1, 2, 3], [1, 2])).toThrow('Vector dimension mismatch: 3 vs 2')
  })
})

describe('addVectors', () => {
  it('adds element by element', () => {
    expect(addVectors([1, 2, 3], [10, 20, 30])).toEqual([11, 22, 33])
  })

  it('refuses vectors of different lengths, naming both', () => {
    expect(() => addVectors([1], [1, 2, 3])).toThrow('Vector dimension mismatch: 1 vs 3')
  })
})

describe('scaleVector', () => {
  it('multiplies every component by the scalar', () => {
    expect(scaleVector([1, -2, 3], 2)).toEqual([2, -4, 6])
  })

  it('scaling by zero contributes nothing rather than erasing the vector', () => {
    // A weight of 0 has to mean "this centroid does not participate", which is
    // a zero contribution to a sum -- not an empty or absent vector.
    expect(scaleVector([1, 2, 3], 0)).toEqual([0, 0, 0])
  })
})

describe('normalizeVector', () => {
  it('returns a unit vector pointing the same way', () => {
    expect(normalizeVector([3, 4])).toEqual([0.6, 0.8])
  })

  it('leaves an already-unit vector alone', () => {
    expect(normalizeVector([1, 0, 0])).toEqual([1, 0, 0])
  })

  it('hands back the zero vector untouched instead of dividing by zero', () => {
    // THE GUARD THAT MATTERS. Dividing by a zero magnitude yields a vector of
    // NaN, and NaN compares false against everything, so the failure surfaces
    // as a search that returns nothing for no stated reason. A zero vector is
    // reachable in normal use: subtracting a centroid from itself.
    expect(normalizeVector([0, 0, 0])).toEqual([0, 0, 0])
  })
})

describe('cosineSimilarity', () => {
  it('scores identical directions 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10)
  })

  it('is about direction, not magnitude', () => {
    // The reason cosine is the measure at all, and the reason clustering can
    // compare a one-line stub against a long transcript: a long document and a
    // short one on the same subject must score the same.
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 10)
  })

  it('scores orthogonal vectors 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  it('scores opposite directions -1', () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 10)
  })

  it('scores a zero vector 0 rather than returning NaN', () => {
    // The clustering loop compares every candidate against every centroid and
    // takes the best. A NaN loses every comparison silently, so an unembeddable
    // all-zero vector would not merely fail to cluster -- it would disappear.
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0)
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0)
  })

  it('refuses vectors of different lengths, naming both', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow('Vector dimension mismatch: 2 vs 3')
  })
})
