import { describe, it, expect } from 'vitest'
import { scoreSteering, type SteeringItem } from './steering-score.js'
import type { Grade } from './types.js'

const item: SteeringItem = {
  id: 'steer-item-grumpy-badger',
  text: 'query-text-velvet-anchor',
  dataClass: ['*'],
  toward: [1],
  away: [2],
  gold: [10, 11],
  offTarget: [20, 21],
  sourceNote: 'fixture',
}

const grades = new Map<number, Grade>([
  [10, 3],
  [11, 3],
  [20, 0],
  [21, 0],
  [30, 1],
])

describe('scoreSteering', () => {
  // base finds gold 10 only; toward finds both: recall@20 goes 1/2 -> 2/2.
  it('measures the gold recall the toward examples add', () => {
    const score = scoreSteering(item, { base: [10, 20, 30], toward: [1, 11, 10], away: [] }, grades)
    expect(score.recallGain20).toBe(0.5)
  })

  // Off-target 20 and 21 sit in the base list; the away list drops 20.
  it('measures the share of off-target results the away examples remove', () => {
    const score = scoreSteering(item, { base: [10, 20, 21, 30], toward: [], away: [10, 21, 30] }, grades)
    expect(score.offTargetRemoved).toBe(0.5)
  })

  // On-target 10 and 30 sit in the base list; the away list loses 30.
  it('measures collateral: on-target results the away examples lose', () => {
    const score = scoreSteering(item, { base: [10, 20, 30], toward: [], away: [10] }, grades)
    expect(score.collateral).toBe(0.5)
  })

  it('does not count an away example leaving the list as off-target removal', () => {
    const score = scoreSteering(item, { base: [2, 10, 30], toward: [], away: [10, 30] }, grades)
    expect(score.offTargetRemoved).toBeNull()
  })

  it('does not credit a toward example coming back as recall', () => {
    const score = scoreSteering({ ...item, gold: [1, 10] }, { base: [10], toward: [1, 10], away: [] }, grades)
    expect(score.recallGain20).toBe(0)
  })
})
