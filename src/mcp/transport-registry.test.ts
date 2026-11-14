import { afterEach, describe, expect, it, vi } from 'vitest'
import { TransportRegistry, type ClosableTransport } from './transport-registry.js'

const transport = (close = vi.fn().mockResolvedValue(undefined)): ClosableTransport & { close: typeof close } => ({ close })

describe('TransportRegistry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes and removes transports after the idle timeout', async () => {
    vi.useFakeTimers()
    const registry = new TransportRegistry<ClosableTransport>(1_000)
    const idle = transport()

    registry.set('idle', idle)
    registry.start()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(registry.size()).toBe(0)
    expect(idle.close).toHaveBeenCalledOnce()
    registry.stop()
  })

  it('rejects invalid timeouts and handles missing sessions safely', () => {
    expect(() => new TransportRegistry<ClosableTransport>(0)).toThrow('greater than zero')

    const registry = new TransportRegistry<ClosableTransport>(1_000)
    expect(registry.get('missing')).toBeUndefined()
    expect(registry.touch('missing')).toBe(false)
    expect(registry.delete('missing')).toBe(false)

    registry.start(2_000)
    registry.start(2_000)
    registry.stop()
    registry.stop()
  })

  it('keeps an active transport and removes an idle one', async () => {
    let now = 0
    const registry = new TransportRegistry<ClosableTransport>(1_000, () => now)
    const active = transport()
    const idle = transport()

    registry.set('active', active)
    registry.set('idle', idle)
    now = 900
    expect(registry.touch('active')).toBe(true)
    now = 1_000

    await registry.expireIdle()

    expect(registry.get('active')).toBe(active)
    expect(registry.get('idle')).toBeUndefined()
    expect(active.close).not.toHaveBeenCalled()
    expect(idle.close).toHaveBeenCalledOnce()
  })

  it('does not close a later entry that was removed during an earlier close', async () => {
    let now = 0
    let registry: TransportRegistry<ClosableTransport>
    const first = transport(vi.fn(async () => {
      registry.delete('second')
    }))
    const second = transport()
    registry = new TransportRegistry<ClosableTransport>(1_000, () => now)

    registry.set('first', first)
    registry.set('second', second)
    now = 1_000

    await expect(registry.expireIdle()).resolves.toBe(1)
    expect(second.close).not.toHaveBeenCalled()
  })

  it('removes a transport even when close fails', async () => {
    let now = 0
    const closeError = new Error('close failed')
    const onCloseError = vi.fn()
    const registry = new TransportRegistry<ClosableTransport>(1_000, () => now, onCloseError)
    const broken = transport(vi.fn().mockRejectedValue(closeError))

    registry.set('broken', broken)
    now = 1_000
    await registry.expireIdle()

    expect(registry.size()).toBe(0)
    expect(onCloseError).toHaveBeenCalledWith('broken', closeError)

    const defaultReporter = new TransportRegistry<ClosableTransport>(1_000, () => now)
    defaultReporter.set('broken', broken)
    now = 2_000
    await defaultReporter.expireIdle()
    expect(defaultReporter.size()).toBe(0)
  })

  it('closes all sessions during shutdown and reports close failures', async () => {
    const closeError = new Error('shutdown close failed')
    const onCloseError = vi.fn()
    const registry = new TransportRegistry<ClosableTransport>(1_000, Date.now, onCloseError)
    const healthy = transport()
    const broken = transport(vi.fn().mockRejectedValue(closeError))

    registry.set('healthy', healthy)
    registry.set('broken', broken)
    await registry.closeAll()

    expect(registry.size()).toBe(0)
    expect(healthy.close).toHaveBeenCalledOnce()
    expect(broken.close).toHaveBeenCalledOnce()
    expect(onCloseError).toHaveBeenCalledWith('broken', closeError)
  })
})
