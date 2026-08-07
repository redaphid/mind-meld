import { describe, it, expect, beforeEach, vi } from 'vitest'

// The default runner reaches straight into the embedding pipeline, so the batch
// module is stubbed: these tests are about the drain's control flow, not about
// Postgres, Chroma, or a GPU.
vi.mock('../embeddings/batch.js', () => ({
  generatePendingEmbeddings: vi.fn(),
  updateAggregateEmbeddings: vi.fn(),
  AGGREGATE_BATCH_SIZE: 100,
}))
// The spool drain runs first in the default runner; unconfigured (the default
// below, and the production default) it is a no-op.
const { drainIngestSpool } = vi.hoisted(() => ({ drainIngestSpool: vi.fn() }))
vi.mock('../sync/ingest-spool.js', () => ({ drainIngestSpool }))

import {
  generatePendingEmbeddings,
  updateAggregateEmbeddings,
} from '../embeddings/batch.js'
import {
  startSyncRun,
  getSyncRunState,
  awaitSyncRun,
  resetSyncRunState,
} from './sync-run.js'

const NO_SPOOL = { configured: false, drained: 0, quarantined: 0, errors: [] }

beforeEach(() => {
  drainIngestSpool.mockReset().mockResolvedValue(NO_SPOOL)
})

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

// The default runner — what the button actually triggers when no stub is passed.
// Aggregates are drained batch-by-batch rather than one batch per press, so the
// loop's stopping condition is the part worth pinning down: stop early and the
// backlog never clears, never stop and one press runs until the time budget.
describe('the default ingestion run', () => {
  beforeEach(() => {
    resetSyncRunState()
    vi.mocked(generatePendingEmbeddings).mockReset()
    vi.mocked(updateAggregateEmbeddings).mockReset()
  })

  describe('when one aggregate batch clears the backlog', () => {
    beforeEach(async () => {
      vi.mocked(generatePendingEmbeddings).mockResolvedValue({
        processed: 12,
        skipped: 0,
        errors: 0,
      } as any)
      vi.mocked(updateAggregateEmbeddings).mockResolvedValue({
        sessionsUpdated: 4,
        sessionsReembedded: 0,
        sessionsFetched: 3, // short of AGGREGATE_BATCH_SIZE, so the drain stops
      })
      startSyncRun()
      await awaitSyncRun()
    })

    it('reports what was embedded', () => {
      expect(getSyncRunState().messagesEmbedded).toBe(12)
    })

    it('stops after the short batch', () => {
      expect(updateAggregateEmbeddings).toHaveBeenCalledTimes(1)
      expect(getSyncRunState().sessionsUpdated).toBe(4)
    })
  })

  describe('when the aggregate backlog spans several batches', () => {
    beforeEach(async () => {
      vi.mocked(generatePendingEmbeddings).mockResolvedValue({
        processed: 0,
        skipped: 0,
        errors: 0,
      } as any)
      // Two full batches, then a short one that ends the drain.
      vi.mocked(updateAggregateEmbeddings)
        .mockResolvedValueOnce({ sessionsUpdated: 100, sessionsReembedded: 0, sessionsFetched: 100 })
        .mockResolvedValueOnce({ sessionsUpdated: 100, sessionsReembedded: 0, sessionsFetched: 100 })
        .mockResolvedValueOnce({ sessionsUpdated: 7, sessionsReembedded: 0, sessionsFetched: 7 })
      startSyncRun()
      await awaitSyncRun()
    })

    it('keeps draining until a batch comes back short', () => {
      expect(updateAggregateEmbeddings).toHaveBeenCalledTimes(3)
    })

    it('totals the sessions updated across every batch', () => {
      expect(getSyncRunState().sessionsUpdated).toBe(207)
    })
  })

  describe('when the embedding pass fails', () => {
    beforeEach(async () => {
      vi.mocked(generatePendingEmbeddings).mockRejectedValue(
        new Error('GPU is in use by other applications right now')
      )
      startSyncRun()
      await awaitSyncRun()
    })

    it('records the failure and never touches the aggregates', () => {
      expect(getSyncRunState().error).toBe('GPU is in use by other applications right now')
      expect(updateAggregateEmbeddings).not.toHaveBeenCalled()
    })
  })

  // In a containers-only deployment this run is the only thing that ever drains
  // the edge spool, so what it drained has to reach the state the UI reads —
  // otherwise the work is invisible and looks like nothing happened.
  describe('when the ingest spool is configured', () => {
    beforeEach(() => {
      vi.mocked(generatePendingEmbeddings).mockResolvedValue({
        processed: 5,
        skipped: 0,
        errors: 0,
      } as any)
      vi.mocked(updateAggregateEmbeddings).mockResolvedValue({
        sessionsUpdated: 0,
        sessionsReembedded: 0,
        sessionsFetched: 0,
      })
    })

    it('reports what the spool drained alongside the embedding counts', async () => {
      drainIngestSpool.mockResolvedValue({
        configured: true,
        drained: 3,
        quarantined: 1,
        errors: [],
      })
      startSyncRun()
      await awaitSyncRun()

      const state = getSyncRunState()
      expect(state.spoolDrained).toBe(3)
      expect(state.spoolQuarantined).toBe(1)
      expect(state.messagesEmbedded).toBe(5)
      expect(state.error).toBeNull()
    })

    // Spool errors are transport-level — the payloads themselves are already
    // safe in sync_quarantine — so they are reported without costing the
    // embedding half of the run, which is the expensive half.
    it('surfaces spool errors without aborting the embedding pass', async () => {
      drainIngestSpool.mockResolvedValue({
        configured: true,
        drained: 0,
        quarantined: 0,
        errors: ['ingest spool list failed: HTTP 503', 'ingest spool unreachable: Error: reset'],
      })
      startSyncRun()
      await awaitSyncRun()

      const state = getSyncRunState()
      expect(state.error).toBe(
        'ingest spool list failed: HTTP 503; ingest spool unreachable: Error: reset'
      )
      expect(state.messagesEmbedded).toBe(5)
      expect(generatePendingEmbeddings).toHaveBeenCalledOnce()
    })

    // Order matters: what the spool lands is exactly what the embedding pass
    // below it should then pick up, in the same press of the button.
    it('drains the spool before embedding', async () => {
      drainIngestSpool.mockResolvedValue({
        configured: true,
        drained: 1,
        quarantined: 0,
        errors: [],
      })
      startSyncRun()
      await awaitSyncRun()

      expect(drainIngestSpool.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(generatePendingEmbeddings).mock.invocationCallOrder[0]
      )
    })
  })
})
