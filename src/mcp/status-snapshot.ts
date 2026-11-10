export const cacheStatusSnapshot = <T>(
  load: () => Promise<T>,
  { refreshAfterMs = 30000, now = Date.now } = {},
): (() => Promise<T>) => {
  let snapshot: { value: T; expiresAt: number } | null = null
  let pending: Promise<T> | null = null
  return () => {
    if (snapshot && now() < snapshot.expiresAt) return Promise.resolve(snapshot.value)
    if (pending) return pending
    pending = load().then(value => {
      snapshot = { value, expiresAt: now() + refreshAfterMs }
      return value
    }).finally(() => { pending = null })
    return pending
  }
}
