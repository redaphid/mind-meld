import { describe, it, expect, beforeEach } from 'vitest'
import {
  startSyncRun,
  getSyncRunState,
  awaitSyncRun,
  resetSyncRunState,
} from './sync-run.js'

// The button behind this is one anyone can hold down. What matters is that a
// second press cannot start a second drain — two would compete for the same
// pending rows and for the single Ollama slot the gate hands out.
describe('startSyncRun', () => {
  beforeEach(() => {
    resetSyncRunState()
  })

  describe('when nothing is running', () => {
    it('starts a run and reports it in flight', async () => {
      const { started, state } = startSyncRun(async () => ({
        messagesEmbedded: 3,
        sessionsUpdated: 1,
      }))

      expect(started).toBe(true)
      expect(state.running).toBe(true)
      expect(state.startedAt).not.toBeNull()

      await awaitSyncRun()
    })

    it('records what the run produced once it finishes', async () => {
      startSyncRun(async () => ({ messagesEmbedded: 42, sessionsUpdated: 7 }))
      await awaitSyncRun()

      const state = getSyncRunState()
      expect(state.running).toBe(false)
      expect(state.messagesEmbedded).toBe(42)
      expect(state.sessionsUpdated).toBe(7)
      expect(state.error).toBeNull()
      expect(state.finishedAt).not.toBeNull()
      expect(state.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('when a run is already in flight', () => {
    let release: () => void
    let runs: number

    beforeEach(() => {
      runs = 0
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      startSyncRun(async () => {
        runs++
        await gate
        return { messagesEmbedded: 1, sessionsUpdated: 0 }
      })
    })

    it('refuses to start a second one', () => {
      const second = startSyncRun(async () => {
        runs++
        return { messagesEmbedded: 99, sessionsUpdated: 99 }
      })

      expect(second.started).toBe(false)
      expect(second.state.running).toBe(true)
      expect(runs).toBe(1)
    })

    it('accepts a new run once the first finishes', async () => {
      release()
      await awaitSyncRun()

      const second = startSyncRun(async () => ({
        messagesEmbedded: 5,
        sessionsUpdated: 2,
      }))
      expect(second.started).toBe(true)

      await awaitSyncRun()
      expect(getSyncRunState().messagesEmbedded).toBe(5)
    })
  })

  describe('when the run throws', () => {
    beforeEach(async () => {
      startSyncRun(async () => {
        throw new Error('ollama refused: GPU is in use')
      })
      await awaitSyncRun()
    })

    // The drain runs detached from the request that started it, so a failure
    // has nowhere to propagate except the state the UI reads back.
    it('records the failure instead of rejecting', () => {
      const state = getSyncRunState()
      expect(state.error).toBe('ollama refused: GPU is in use')
      expect(state.running).toBe(false)
      expect(state.finishedAt).not.toBeNull()
    })

    it('leaves the runner free to try again', () => {
      expect(startSyncRun(async () => ({ messagesEmbedded: 0, sessionsUpdated: 0 })).started).toBe(
        true
      )
    })
  })
})
