export interface ClosableTransport {
  close: () => Promise<void> | void
}

type Entry<T> = {
  transport: T
  lastActivityAt: number
}

export class TransportRegistry<T extends ClosableTransport> {
  private readonly entries = new Map<string, Entry<T>>()
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly idleMs: number,
    private readonly now: () => number = Date.now,
    private readonly onCloseError: (sessionId: string, error: unknown) => void = () => {},
  ) {
    if (!Number.isFinite(idleMs) || idleMs <= 0) {
      throw new Error('Transport idle timeout must be greater than zero')
    }
  }

  set(sessionId: string, transport: T): void {
    this.entries.set(sessionId, { transport, lastActivityAt: this.now() })
  }

  get(sessionId: string): T | undefined {
    return this.entries.get(sessionId)?.transport
  }

  touch(sessionId: string): boolean {
    const entry = this.entries.get(sessionId)
    if (!entry) return false
    entry.lastActivityAt = this.now()
    return true
  }

  delete(sessionId: string): boolean {
    return this.entries.delete(sessionId)
  }

  size(): number {
    return this.entries.size
  }

  start(sweepMs = Math.min(this.idleMs, 60_000)): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => {
      void this.expireIdle()
    }, sweepMs)
    this.sweepTimer.unref?.()
  }

  stop(): void {
    if (!this.sweepTimer) return
    clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  async expireIdle(at = this.now()): Promise<number> {
    const expired = [...this.entries].filter(([, entry]) => at - entry.lastActivityAt >= this.idleMs)
    let removed = 0

    for (const [sessionId, entry] of expired) {
      if (!this.entries.delete(sessionId)) continue
      removed++
      try {
        await entry.transport.close()
      } catch (error) {
        this.onCloseError(sessionId, error)
      }
    }

    return removed
  }

  async closeAll(): Promise<void> {
    this.stop()
    const entries = [...this.entries]
    this.entries.clear()

    for (const [sessionId, entry] of entries) {
      try {
        await entry.transport.close()
      } catch (error) {
        this.onCloseError(sessionId, error)
      }
    }
  }
}
