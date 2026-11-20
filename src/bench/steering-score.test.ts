import { describe, it, expect } from 'vitest'
import { reportSteering, scoreSteering, type SteeringItem } from './steering-score.js'
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

  // Relevant 10 and 11 sit in the base list beside marginal 30; the away list keeps only 10.
  it('measures collateral: relevant results the away examples lose', () => {
    const score = scoreSteering(item, { base: [10, 11, 20, 30], toward: [], away: [10] }, grades)
    expect(score.collateral).toBe(0.5)
  })

  it('does not count a lost irrelevant bystander as collateral', () => {
    const score = scoreSteering(item, { base: [10, 30], toward: [], away: [10] }, grades)
    expect(score.collateral).toBe(0)
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

describe('reportSteering', () => {
  const names = { base: 'hybrid', toward: 'hybrid-toward', away: 'hybrid-away' }

  // An item with no off-target result in its base list has nothing to remove;
  // counting it as 0 would drag the mean down for something the examples never faced.
  it('averages each metric over the items that have it', () => {
    const report = reportSteering(names, [
      { itemId: 'a', recallGain20: 0.5, ndcgGain10: 0.2, offTargetRemoved: 1, collateral: null },
      { itemId: 'b', recallGain20: 0, ndcgGain10: null, offTargetRemoved: null, collateral: null },
    ])
    expect(report.system).toEqual(names)
    expect(report.n).toBe(2)
    expect(report.recallGain20!.mean).toBe(0.25)
    expect(report.ndcgGain10!.mean).toBe(0.2)
    expect(report.offTargetRemoved!.mean).toBe(1)
    expect(report.collateral).toBeNull()
  })
})
