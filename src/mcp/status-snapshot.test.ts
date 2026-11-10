import { describe, expect, it, vi } from 'vitest'
import { cacheStatusSnapshot } from './status-snapshot.js'

describe('when status reads overlap', () => {
  it('shares the unfinished snapshot instead of starting duplicate work', async () => {
    let finish = (_value: string) => {}
    const load = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const read = cacheStatusSnapshot(load)
    const first = read(), second = read()
    finish('The kraken is awake.')
    expect(await Promise.all([first, second])).toEqual(['The kraken is awake.', 'The kraken is awake.'])
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('refreshes after the last completed snapshot expires', async () => {
    let clock = 0
    const load = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new')
    const read = cacheStatusSnapshot(load, { refreshAfterMs: 30, now: () => clock })
    await read()
    clock = 29
    expect(await read()).toBe('old')
    clock = 30
    expect(await read()).toBe('new')
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('does not keep a rejected refresh pinned forever', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('The lair is offline.')).mockResolvedValueOnce('recovered')
    const read = cacheStatusSnapshot(load)
    await expect(read()).rejects.toThrow('The lair is offline.')
    expect(await read()).toBe('recovered')
  })
})
