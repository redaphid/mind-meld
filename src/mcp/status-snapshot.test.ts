import { describe, expect, it, vi } from 'vitest'
import { staleWhileRevalidate } from './status-snapshot.js'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('staleWhileRevalidate', () => {
  it('answers before the first count finishes, then serves it', async () => {
    let finish = (_value: string) => {}
    const load = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const read = staleWhileRevalidate(load, { refreshAfterMs: 30 })
    expect(read()).toBeNull()
    expect(read()).toBeNull()
    finish('The kraken is awake.')
    await settle()
    expect(read()?.value).toBe('The kraken is awake.')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps serving the old snapshot while a stale one is recounted', async () => {
    let clock = 0
    let finish = (_value: string) => {}
    const load = vi.fn()
      .mockResolvedValueOnce('old')
      .mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve }))
    const read = staleWhileRevalidate(load, { refreshAfterMs: 30, now: () => clock })
    read()
    await settle()
    clock = 29
    expect(read()?.value).toBe('old')
    expect(load).toHaveBeenCalledTimes(1)
    clock = 30
    expect(read()?.value).toBe('old')
    expect(read()?.value).toBe('old')
    expect(load).toHaveBeenCalledTimes(2)
    finish('new')
    await settle()
    expect(read()).toEqual({ value: 'new', asOf: new Date(30) })
  })

  it('keeps the last good snapshot when a recount fails, and tries again', async () => {
    let clock = 0
    const load = vi.fn()
      .mockResolvedValueOnce('Valley of the Sun')
      .mockRejectedValueOnce(new Error('The lair is offline.'))
      .mockResolvedValueOnce('The Rusty Conquistador')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const read = staleWhileRevalidate(load, { refreshAfterMs: 30, now: () => clock })
    read()
    await settle()
    clock = 30
    read()
    await settle()
    expect(read()?.value).toBe('Valley of the Sun')
    await settle()
    expect(read()?.value).toBe('The Rusty Conquistador')
    expect(errors).toHaveBeenCalledWith('[status] count refresh failed:', 'The lair is offline.')
    errors.mockRestore()
  })
})
