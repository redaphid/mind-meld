import { describe, it, expect } from 'vitest'
import {
  agreement,
  bootstrapMean,
  dcgAt,
  junkAt,
  meanGradeAt,
  ndcgAt,
  pairedBootstrap,
  percentile,
  recallAt,
  reciprocalRank,
  shuffled,
} from './metrics.js'

// Worked by hand: gains 2^g - 1 = 7, 3, 0 at discounts log2(2), log2(3), log2(4).
// DCG = 7/1 + 3/1.584963 + 0/2 = 8.892789.
describe('dcgAt', () => {
  it('sums graded gain over a log2 rank discount', () => {
    expect(dcgAt([3, 2, 0], 10)).toBeCloseTo(8.892789, 5)
  })

  it('ignores ranks past k', () => {
    expect(dcgAt([3, 2, 3], 1)).toBe(7)
  })
})

describe('ndcgAt', () => {
  // [0, 2, 3]: 0/1 + 3/1.584963 + 7/2 = 5.392789; ideal [3, 2, 0] = 8.892789.
  it('divides by the DCG of the best order of every judged grade', () => {
    expect(ndcgAt([0, 2, 3], [3, 2, 0], 10)).toBeCloseTo(0.606423, 5)
  })

  it('is 1 for the ideal order', () => {
    expect(ndcgAt([3, 2, 0], [0, 3, 2], 10)).toBeCloseTo(1, 10)
  })

  it('counts relevant documents the run missed against it', () => {
    expect(ndcgAt([3], [3, 3], 10)).toBeCloseTo(7 / (7 + 7 / Math.log2(3)), 10)
  })

  it('is undefined when nothing judged is relevant', () => {
    expect(ndcgAt([0, 0], [0, 0, 0], 10)).toBeNull()
  })
})

describe('reciprocalRank', () => {
  it('is one over the rank of the first gold hit', () => {
    expect(reciprocalRank([5, 6, 7], [7, 6])).toBe(0.5)
  })

  it('is 0 when no gold is retrieved', () => {
    expect(reciprocalRank([5, 6], [7])).toBe(0)
  })

  it('is undefined without gold', () => {
    expect(reciprocalRank([5], [])).toBeNull()
  })
})

describe('recallAt', () => {
  it('is the share of gold found within k', () => {
    expect(recallAt([1, 2, 3, 4], [2, 4, 9], 3)).toBeCloseTo(1 / 3, 10)
  })
})

describe('meanGradeAt and junkAt', () => {
  it('averages the grades of the first k returned', () => {
    expect(meanGradeAt([3, 0, 1, 2, 2, 3], 5)).toBe(1.6)
  })

  it('counts grade 0 among the first k returned', () => {
    expect(junkAt([3, 0, 1, 0, 2, 0], 5)).toBe(0.4)
  })

  it('has no junk rate for an empty result list', () => {
    expect(junkAt([], 5)).toBeNull()
  })
})

describe('percentile', () => {
  it('interpolates between closest ranks', () => {
    expect(percentile([4, 1, 3, 2], 0.9)).toBeCloseTo(3.7, 10)
  })

  it('takes the midpoint for an even median', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5)
  })
})

describe('bootstrapMean', () => {
  it('has a zero-width interval for constant data', () => {
    const interval = bootstrapMean([0.4, 0.4, 0.4])!
    expect(interval.hi - interval.lo).toBeCloseTo(0, 12)
  })

  it('brackets the mean of varied data', () => {
    const interval = bootstrapMean([0, 1, 0, 1, 1, 0, 1, 0])!
    expect(interval.lo < 0.5 && interval.hi > 0.5).toBe(true)
  })

  // 100 values of 0 and 1: standard error 0.05, so a 95% interval is about
  // 0.196 wide and a 90% one about 0.164.
  it('is a 95% interval', () => {
    const interval = bootstrapMean(Array.from({ length: 100 }, (_, i) => i % 2))!
    expect(interval.hi - interval.lo).toBeGreaterThan(0.18)
    expect(interval.hi - interval.lo).toBeLessThan(0.21)
  })

  it('repeats exactly under the same seed', () => {
    expect(bootstrapMean([0, 0.3, 0.9, 1])).toEqual(bootstrapMean([0, 0.3, 0.9, 1]))
  })
})

describe('pairedBootstrap', () => {
  it('does not separate identical systems', () => {
    expect(pairedBootstrap([0.1, 0.5, 0.9], [0.1, 0.5, 0.9])!.excludesZero).toBe(false)
  })

  // Per-query scores vary widely, but b beats a by 0.1 on every query: the
  // paired interval must see that even though unpaired means overlap.
  it('separates a small consistent gain hidden by query variance', () => {
    const a = [0.0, 0.2, 0.4, 0.6, 0.8, 0.1, 0.3, 0.5]
    expect(pairedBootstrap(a, a.map((x) => x + 0.1))!.excludesZero).toBe(true)
  })

  it('reports b minus a', () => {
    expect(pairedBootstrap([0.5, 0.5], [0.2, 0.2])!.mean).toBeCloseTo(-0.3, 10)
  })
})

describe('agreement', () => {
  // Observed weight 1 on every pair; chance expects 0.5; kappa = 1 - 1/0.5.
  it('is -1 for raters who always pick opposite extremes', () => {
    expect(agreement([0, 0, 3, 3], [3, 3, 0, 0]).quadraticKappa).toBeCloseTo(-1, 10)
  })

  // Observed (1/9)/4 = 0.027778; expected 0.222222 from the marginals.
  it('discounts a one-step disagreement by its square', () => {
    expect(agreement([0, 1, 2, 3], [0, 1, 2, 2]).quadraticKappa).toBeCloseTo(0.875, 6)
  })

  it('reports exact agreement', () => {
    expect(agreement([0, 1, 2, 3], [0, 1, 2, 2]).exact).toBe(0.75)
  })
})

describe('shuffled', () => {
  it('keeps every item', () => {
    expect(shuffled([1, 2, 3, 4, 5], 'seed-x').sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('is fixed by its seed', () => {
    expect(shuffled([1, 2, 3, 4, 5, 6], 'seed-y')).toEqual(shuffled([1, 2, 3, 4, 5, 6], 'seed-y'))
  })
})
