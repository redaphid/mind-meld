import { describe, it, expect } from 'vitest'
import { fuseRanks } from './rrf.js'

describe('fuseRanks', () => {
  it('preserves a single list rank order', () => {
    const fused = fuseRanks([[10, 20, 30]])
    expect(fused.get(10)).toBeGreaterThan(fused.get(20)!)
    expect(fused.get(20)).toBeGreaterThan(fused.get(30)!)
  })

  it('rewards agreement across lists over a single strong hit', () => {
    const semantic = [1, 2, 3]
    const fts = [2, 4, 5]
    const fused = fuseRanks([semantic, fts])
    // 2 appears in both lists; 1 only tops semantic. Consensus wins.
    expect(fused.get(2)).toBeGreaterThan(fused.get(1)!)
  })

  it('lifts a strong keyword match above weak semantic hits', () => {
    // The ticket's scenario: exact-term hit tops FTS, buried in semantic.
    const semantic = [9, 8, 7, 42]
    const fts = [42, 9]
    const fused = fuseRanks([semantic, fts])
    expect(fused.get(42)).toBeGreaterThan(fused.get(8)!)
    expect(fused.get(42)).toBeGreaterThan(fused.get(7)!)
  })

  it('uses 1/(k+rank) with k=60 and 1-based ranks', () => {
    const fused = fuseRanks([[5, 6]], 60)
    expect(fused.get(5)).toBeCloseTo(1 / 61, 10)
    expect(fused.get(6)).toBeCloseTo(1 / 62, 10)
  })

  it('orders the fused map into the expected ranking', () => {
    const a = [100, 200, 300]
    const b = [300, 100, 400]
    const order = [...fuseRanks([a, b]).entries()]
      .sort(([, x], [, y]) => y - x)
      .map(([id]) => id)
    // 100: r0+r1, 300: r2+r0, 200: r1 only, 400: r2 only
    expect(order).toEqual([100, 300, 200, 400])
  })
})
