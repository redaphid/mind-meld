type Snapshot<T> = { value: T | null; asOf: Date | null; error: string | null }

// A recount that fails waits out the same interval as one that succeeds: a
// count that times out under load must not be retried on every poll.
export const staleWhileRevalidate = <T>(
  load: () => Promise<T>,
  { refreshAfterMs, now = Date.now }: { refreshAfterMs: number; now?: () => number },
): (() => Snapshot<T>) => {
  const snapshot: Snapshot<T> = { value: null, asOf: null, error: null }
  let attemptedAt = -Infinity
  let refreshing = false

  const refresh = async () => {
    refreshing = true
    attemptedAt = now()
    try {
      snapshot.value = await load()
      snapshot.asOf = new Date(now())
      snapshot.error = null
    } catch (error) {
      snapshot.error = error instanceof Error ? error.message : String(error)
      console.error('[status] count refresh failed:', snapshot.error)
    } finally {
      refreshing = false
    }
  }

  return () => {
    if (!refreshing && now() - attemptedAt >= refreshAfterMs) void refresh()
    return { ...snapshot }
  }
}
