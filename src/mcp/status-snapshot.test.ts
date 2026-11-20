import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { staleWhileRevalidate } from './status-snapshot.js'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('staleWhileRevalidate', () => {
  describe('when the first count has not finished', () => {
    let finish = (_value: string) => {}
    let load: ReturnType<typeof vi.fn>
    let read: ReturnType<typeof staleWhileRevalidate<string | null>>

    beforeEach(() => {
      load = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
      read = staleWhileRevalidate(load, { initial: null, refreshAfterMs: 30 })
      read()
      read()
    })

    it('answers without a value', () => {
      expect(read()).toEqual({ value: null, asOf: null, error: null })
    })

    it('starts one count however often it is asked', () => {
      expect(load).toHaveBeenCalledTimes(1)
    })

    describe('when it finishes', () => {
      beforeEach(async () => {
        finish('The kraken is awake.')
        await settle()
      })

      it('serves it', () => {
        expect(read().value).toBe('The kraken is awake.')
      })
    })
  })

  describe('when the snapshot goes stale', () => {
    let clock: number
    let finish = (_value: string) => {}
    let load: ReturnType<typeof vi.fn>
    let read: ReturnType<typeof staleWhileRevalidate<string | null>>

    beforeEach(async () => {
      clock = 0
      load = vi.fn()
        .mockResolvedValueOnce('old')
        .mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve }))
      read = staleWhileRevalidate(load, { initial: null, refreshAfterMs: 30, now: () => clock })
      read()
      await settle()
      clock = 29
      read()
      clock = 30
      read()
      read()
    })

    it('keeps serving the old one while it recounts', () => {
      expect(read().value).toBe('old')
    })

    it('recounts once', () => {
      expect(load).toHaveBeenCalledTimes(2)
    })

    describe('when the recount finishes', () => {
      beforeEach(async () => {
        finish('new')
        await settle()
      })

      it('serves the new one, stamped when it finished', () => {
        expect(read()).toEqual({ value: 'new', asOf: new Date(30), error: null })
      })
    })
  })

  describe('when a recount fails', () => {
    let clock: number
    let load: ReturnType<typeof vi.fn>
    let read: ReturnType<typeof staleWhileRevalidate<string | null>>

    beforeEach(async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      clock = 0
      load = vi.fn()
        .mockResolvedValueOnce('Valley of the Sun')
        .mockRejectedValueOnce(new Error('canceling statement due to statement timeout'))
        .mockResolvedValueOnce('The Rusty Conquistador')
      read = staleWhileRevalidate(load, { initial: null, refreshAfterMs: 30, now: () => clock })
      read()
      await settle()
      clock = 30
      read()
      await settle()
      clock = 59
      read()
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('keeps the last good value and says why it is old', () => {
      expect(read()).toEqual({
        value: 'Valley of the Sun',
        asOf: new Date(0),
        error: 'Error: canceling statement due to statement timeout',
      })
    })

    it('waits a full interval before trying again', () => {
      expect(load).toHaveBeenCalledTimes(2)
    })

    describe('when the next interval passes', () => {
      beforeEach(async () => {
        clock = 60
        read()
        await settle()
      })

      it('recounts and clears the error', () => {
        expect(read()).toEqual({ value: 'The Rusty Conquistador', asOf: new Date(60), error: null })
      })
    })
  })
})
