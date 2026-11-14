import { bootstrapMean, ndcgAt, recallAt } from './metrics.js'
import type { Grade, Interval } from './types.js'

// One steering trial: a query, example sessions to steer toward and away
// from, the sessions that should rise (gold, judged relevant) and those that
// should fall (off-target, judged irrelevant and resembling the away examples).
export type SteeringItem = {
  id: string
  text: string
  dataClass: string[]
  toward: number[]
  away: number[]
  gold: number[]
  offTarget: number[]
  sourceNote: string
}

export const STEER_DEPTH = 20

export type SteeringScore = {
  itemId: string
  recallGain20: number
  ndcgGain10: number | null
  offTargetRemoved: number | null
  collateral: number | null
}

const top = (ids: number[], k: number) => ids.slice(0, k)

// Examples are excluded from every list before scoring: a toward example
// coming back proves nothing, and an away example vanishing is the input.
export const scoreSteering = (
  item: SteeringItem,
  lists: { base: number[]; toward: number[]; away: number[] },
  grades: Map<number, Grade>
): SteeringScore => {
  const examples = new Set([...item.toward, ...item.away])
  const clean = (ids: number[]) => ids.filter((id) => !examples.has(id))
  const base = top(clean(lists.base), STEER_DEPTH)
  const toward = top(clean(lists.toward), STEER_DEPTH)
  const away = top(clean(lists.away), STEER_DEPTH)
  const gradesOf = (ids: number[]) => ids.map((id) => grades.get(id) ?? 0)
  const judged = [...grades].filter(([id]) => !examples.has(id)).map(([, g]) => g)
  const baseNdcg = ndcgAt(gradesOf(base), judged, 10)
  const towardNdcg = ndcgAt(gradesOf(toward), judged, 10)
  const offInBase = base.filter((id) => item.offTarget.includes(id))
  // Collateral is what a person would miss: relevant results the away search
  // drops. Losing an irrelevant bystander costs nothing.
  const relevantInBase = base.filter((id) => !item.offTarget.includes(id) && (grades.get(id) ?? 0) >= 2)
  return {
    itemId: item.id,
    recallGain20: recallAt(toward, item.gold, STEER_DEPTH)! - recallAt(base, item.gold, STEER_DEPTH)!,
    ndcgGain10: baseNdcg === null || towardNdcg === null ? null : towardNdcg - baseNdcg,
    offTargetRemoved: offInBase.length === 0 ? null : offInBase.filter((id) => !away.includes(id)).length / offInBase.length,
    collateral: relevantInBase.length === 0 ? null : relevantInBase.filter((id) => !away.includes(id)).length / relevantInBase.length,
  }
}

export type SteeringReport = {
  system: { base: string; toward: string; away: string }
  n: number
  recallGain20: Interval | null
  ndcgGain10: Interval | null
  offTargetRemoved: Interval | null
  collateral: Interval | null
}

export const reportSteering = (system: SteeringReport['system'], scores: SteeringScore[]): SteeringReport => {
  const interval = (pick: (s: SteeringScore) => number | null) =>
    bootstrapMean(scores.map(pick).filter((v): v is number => v !== null))
  return {
    system,
    n: scores.length,
    recallGain20: interval((s) => s.recallGain20),
    ndcgGain10: interval((s) => s.ndcgGain10),
    offTargetRemoved: interval((s) => s.offTargetRemoved),
    collateral: interval((s) => s.collateral),
  }
}
