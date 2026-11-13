import { describe, it, expect, beforeEach, vi } from 'vitest'

// The scheduled sync is what every worker container runs once a cycle. These
// tests are about which phases it runs under the AI gate, so every phase is
// stubbed and only the orchestration is real.

const { aiHold } = vi.hoisted(() => ({ aiHold: vi.fn() }))
vi.mock('./sync-control.js', () => ({
  aiHold,
  AI_HOLD_NOTICE: { 'semantic-off': 'semantic off', 'standing-down': 'standing down' },
}))

const noSessions = { projectsProcessed: 0, sessionsProcessed: 0, messagesInserted: 0, skipped: 0, quarantined: 0, errors: [] }
vi.mock('./claude-code.js', () => ({
  syncClaudeCode: vi.fn(async () => noSessions),
  syncClaudeHistory: vi.fn(async () => ({ entriesInserted: 0, malformedLines: 0, invalidTimestamps: 0 })),
}))
vi.mock('./codex.js', () => ({ syncCodex: vi.fn(async () => noSessions) }))
vi.mock('./claude-memory.js', () => ({
  syncClaudeMemories: vi.fn(async () => ({ errors: [] })),
  emptyMemoryStats: () => ({}),
}))
vi.mock('./ingest-spool.js', () => ({
  drainIngestSpool: vi.fn(async () => ({ configured: false, drained: 0, quarantined: 0, errors: [] })),
}))
vi.mock('../embeddings/batch.js', () => ({
  generatePendingEmbeddings: vi.fn(async () => ({ processed: 0, skipped: 0, errors: 0, stalled: null })),
  updateAggregateEmbeddings: vi.fn(async () => ({ sessionsUpdated: 0, sessionsReembedded: 0, sessionsFetched: 0 })),
  AGGREGATE_BATCH_SIZE: 100,
}))
vi.mock('../embeddings/ollama.js', () => ({ ensureEmbeddingModel: vi.fn() }))
vi.mock('../embeddings/summarize.js', () => ({ ensureSummarizeModel: vi.fn() }))
vi.mock('../db/postgres.js', () => ({ query: vi.fn() }))

import { runFullSync } from './orchestrator.js'
import { syncClaudeCode, syncClaudeHistory } from './claude-code.js'
import { syncCodex } from './codex.js'
import { drainIngestSpool } from './ingest-spool.js'
import { generatePendingEmbeddings, updateAggregateEmbeddings } from '../embeddings/batch.js'
import { ensureEmbeddingModel } from '../embeddings/ollama.js'
import { ensureSummarizeModel } from '../embeddings/summarize.js'

beforeEach(() => {
  vi.clearAllMocks()
  aiHold.mockResolvedValue(null)
})

describe('runFullSync', () => {
  it('runs the model checks and the embedding phase when nothing holds them', async () => {
    const result = await runFullSync()

    expect(ensureEmbeddingModel).toHaveBeenCalled()
    expect(generatePendingEmbeddings).toHaveBeenCalled()
    expect(result.held).toBeNull()
  })

  // Full-text-only mode: transcripts keep landing in Postgres, and not one
  // request reaches Ollama -- the model checks included, which run first.
  describe('with semantic switched off', () => {
    beforeEach(() => aiHold.mockResolvedValue('semantic-off'))

    it('still reads transcripts into Postgres', async () => {
      await runFullSync()
      expect(syncClaudeCode).toHaveBeenCalled()
    })

    it('reaches nothing in Ollama', async () => {
      await runFullSync()
      expect(ensureEmbeddingModel).not.toHaveBeenCalled()
      expect(ensureSummarizeModel).not.toHaveBeenCalled()
      expect(generatePendingEmbeddings).not.toHaveBeenCalled()
    })

    // A run that records an error exits nonzero, and monitoring would read a
    // deliberate switch as a failing sync every cycle.
    it('reports why it held, and not as an error', async () => {
      const result = await runFullSync()
      expect(result.held).toBe('semantic-off')
      expect(result.errors).toEqual([])
    })
  })
})

describe('runFullSync phases', () => {
  // A stand-down holds the same phase, for the same reason, and is no more an
  // error than switching semantic off.
  it('holds the embedding phase for a stand-down without recording an error', async () => {
    aiHold.mockResolvedValue('standing-down')
    const result = await runFullSync()
    expect(result.held).toBe('standing-down')
    expect(generatePendingEmbeddings).not.toHaveBeenCalled()
    expect(result.errors).toEqual([])
  })

  it('skips the model checks when embeddings were not asked for', async () => {
    const result = await runFullSync({ skipEmbeddings: true })
    expect(ensureEmbeddingModel).not.toHaveBeenCalled()
    expect(generatePendingEmbeddings).not.toHaveBeenCalled()
    expect(result.held).toBeNull()
  })

  // Switching off partway through a long aggregate drain must end the drain
  // at the next batch, not keep asking for batches it will not work.
  it('stops the aggregate drain when a hold arrives partway through', async () => {
    vi.mocked(updateAggregateEmbeddings).mockResolvedValueOnce({
      sessionsUpdated: 1,
      sessionsReembedded: 0,
      sessionsFetched: 100,
    })
    aiHold.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue('semantic-off')
    const result = await runFullSync()
    expect(updateAggregateEmbeddings).toHaveBeenCalledTimes(1)
    expect(result.embeddings.sessionsUpdated).toBe(1)
  })

  // Every phase reads different files or a different queue, so one failing
  // must not cost the others their run -- and must not vanish either.
  it('records each failing phase and still runs the rest', async () => {
    vi.mocked(syncClaudeCode).mockRejectedValueOnce(new Error('transcripts unreadable'))
    vi.mocked(syncCodex).mockRejectedValueOnce(new Error('codex unreadable'))
    vi.mocked(drainIngestSpool).mockRejectedValueOnce(new Error('spool down'))
    vi.mocked(generatePendingEmbeddings).mockRejectedValueOnce(new Error('ollama down'))
    const result = await runFullSync()
    expect(result.errors).toEqual([
      expect.stringContaining('transcripts unreadable'),
      expect.stringContaining('codex unreadable'),
      expect.stringContaining('spool down'),
      expect.stringContaining('ollama down'),
    ])
  })

  it('treats a missing history file as normal, and any other failure as an error', async () => {
    vi.mocked(syncClaudeHistory).mockRejectedValueOnce(Object.assign(new Error('no file'), { code: 'ENOENT' }))
    expect((await runFullSync()).errors).toEqual([])

    vi.mocked(syncClaudeHistory).mockRejectedValueOnce(new Error('permission denied'))
    expect((await runFullSync()).errors).toEqual([expect.stringContaining('permission denied')])
  })
})
