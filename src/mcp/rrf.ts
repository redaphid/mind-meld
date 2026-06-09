const RRF_K = 60

export type RankedList = number[]

export const fuseRanks = (lists: RankedList[], k: number = RRF_K): Map<number, number> => {
  const fused = new Map<number, number>()
  for (const list of lists)
    list.forEach((id, rank) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank + 1))
    })
  return fused
}
