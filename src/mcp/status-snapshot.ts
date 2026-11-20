export type Snapshot<T> = { value: T; asOf: Date }

export const staleWhileRevalidate = <T>(
  load: () => Promise<T>,
  { refreshAfterMs, now = Date.now }: { refreshAfterMs: number; now?: () => number },
): (() => Snapshot<T> | null) => {
  let snapshot: Snapshot<T> | null = null
  let refreshing = false

  const refresh = async () => {
    refreshing = true
    try {
      snapshot = { value: await load(), asOf: new Date(now()) }
    } catch (error) {
      console.error('[status] count refresh failed:', error instanceof Error ? error.message : error)
    } finally {
      refreshing = false
    }
  }

  return () => {
    const stale = !snapshot || now() - snapshot.asOf.getTime() >= refreshAfterMs
    if (stale && !refreshing) void refresh()
    return snapshot
  }
}
