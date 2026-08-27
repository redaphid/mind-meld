import { describe, it, expect, beforeEach, vi } from 'vitest'

// The embedding queue is global, ordered by message id, and nothing claims a
// row. That makes "a batch that embedded nothing" indistinguishable from "the
// batch before it" — the next select returns the same rows. These tests are
// about the loop's stopping conditions only, so Postgres, Chroma, the GPU and
// the clock are all stubbed; what is real is the control flow.

const { queryMock, generateEmbeddingsMock, summarizeMock, shouldStandDownMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  generateEmbeddingsMock: vi.fn(),
  summarizeMock: vi.fn(),
  shouldStandDownMock: vi.fn(),
}))

vi.mock('../db/postgres.js', () => ({ query: queryMock, queries: {} }))
vi.mock('../db/chroma.js', () => ({
  addEmbeddings: vi.fn(),
  upsertEmbeddings: vi.fn(),
  getEmbeddingMetadata: vi.fn(),
  getCollection: vi.fn(),
}))
vi.mock('./ollama.js', () => ({
  generateEmbeddings: generateEmbeddingsMock,
  ensureEmbeddingModel: vi.fn(),
}))
vi.mock('./summarize.js', () => ({
  summarizeConversation: summarizeMock,
  ensureSummarizeModel: vi.fn(),
  combineSummaries: vi.fn(),
}))
vi.mock('./chunks.js', () => ({ persistSessionChunks: vi.fn() }))
vi.mock('./classify.js', () => ({ classifyNoise: () => null }))
vi.mock('./pending.js', () => ({
  embeddableMessages: () => ({ sql: 'FROM messages m', params: [] }),
  embeddableSessions: () => 'FROM sessions s',
}))
vi.mock('../sync/stand-down.js', () => ({
  shouldStandDown: shouldStandDownMock,
  STAND_DOWN_NOTICE: 'standing down',
}))
// retryDelayMs is what the stall backoff multiplies, so zero keeps these tests
// at wall-clock zero without faking timers.
vi.mock('../config.js', () => ({
  config: {
    embeddings: { batchSize: 100, model: 'bge-m3', dimensions: 1024, summarizeModel: 'qwen3' },
    chroma: { collections: { messages: 'convo-messages', sessions: 'convo-sessions' } },
    healing: { retryLimit: 3, cooldownDays: 7 },
    ollama: { retryDelayMs: 0 },
  },
}))

import { generatePendingEmbeddings, MAX_STALLED_BATCHES } from './batch.js'

const message = (id: number) => ({
  id,
  session_id: 1,
  content_text: `message ${id} with enough text to be embeddable`,
  role: 'user',
  timestamp: new Date('2026-08-07T00:00:00.000Z'),
  project_path: '/projects/example',
  source_name: 'claude_code',
  model: null,
})

// Serves one select's worth of pending rows per call, so a test can say "these
// rows, then nothing" or "these rows, forever" — the latter being what a queue
// that never drains actually looks like from in here.
const servePending = (batches: ReturnType<typeof message>[][], repeatLast = false) => {
  let call = 0
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('COUNT(*) as count')) return { rows: [{ count: '0' }] }
    if (sql.includes('SELECT m.id, m.session_id')) {
      const batch = batches[call] ?? (repeatLast ? batches[batches.length - 1] : [])
      call++
      return { rows: batch }
    }
    return { rows: [], rowCount: 0 }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  shouldStandDownMock.mockResolvedValue(false)
  summarizeMock.mockResolvedValue('a summary long enough to pass the length check')
})

describe('generatePendingEmbeddings', () => {
  describe('when every batch fails to embed', () => {
    let stats: Awaited<ReturnType<typeof generatePendingEmbeddings>>

    beforeEach(async () => {
      // The upstream refusing everything: the GPU gate answering 503 to each
      // embed, surfaced by the ollama client as a thrown error.
      servePending([[message(1), message(2)]], true)
      generateEmbeddingsMock.mockRejectedValue(new Error('503 GPU is in use by other applications'))
      stats = await generatePendingEmbeddings()
    })

    // Without this the run never returns at all: the loop's only exit was a
    // `break`, and the catch counted the error and continued onto the identical
    // rows. The test finishing is itself the assertion.
    it('gives up instead of re-selecting the same rows forever', () => {
      expect(generateEmbeddingsMock).toHaveBeenCalledTimes(MAX_STALLED_BATCHES)
    })

    it('reports why it stopped, carrying the upstream error', () => {
      expect(stats.stalled).toContain('embedded nothing')
      expect(stats.stalled).toContain('GPU is in use')
    })

    it('embedded nothing, and says so rather than reporting a clean drain', () => {
      expect(stats.processed).toBe(0)
      expect(stats.errors).toBe(MAX_STALLED_BATCHES)
    })
  })

  // The silent variant, and the reason the fix counts drained rows rather than
  // caught exceptions: when every message in a batch fails summarization, the
  // batch throws nothing, embeds nothing, marks nothing, and loops on the same
  // rows with the error counter never moving.
  describe('when a batch throws nothing but still drains no rows', () => {
    let stats: Awaited<ReturnType<typeof generatePendingEmbeddings>>

    beforeEach(async () => {
      const long = { ...message(1), content_text: 'x'.repeat(9000) }
      servePending([[long]], true)
      summarizeMock.mockRejectedValue(new Error('upstream unavailable'))
      stats = await generatePendingEmbeddings()
    })

    it('still terminates on the no-progress bound', () => {
      expect(stats.stalled).toContain('still pending')
      expect(summarizeMock).toHaveBeenCalledTimes(MAX_STALLED_BATCHES)
    })

    it('records no errors, because nothing threw', () => {
      expect(stats.errors).toBe(0)
    })
  })

  describe('when batches are doing real work', () => {
    let stats: Awaited<ReturnType<typeof generatePendingEmbeddings>>

    beforeEach(async () => {
      // Two rows, then an empty select: the shape of a queue that drains.
      servePending([[message(1), message(2)], []])
      generateEmbeddingsMock.mockResolvedValue([[0.1], [0.2]])
      stats = await generatePendingEmbeddings()
    })

    it('drains to the end and reports no stall', () => {
      expect(stats.processed).toBe(2)
      expect(stats.stalled).toBeNull()
    })
  })

  // The bound is on *consecutive* stalls. A gate that reopens mid-run must not
  // be punished for the batches it refused before it did.
  describe('when a failing batch later succeeds', () => {
    let stats: Awaited<ReturnType<typeof generatePendingEmbeddings>>

    beforeEach(async () => {
      servePending([[message(1)], [message(1)], []])
      generateEmbeddingsMock
        .mockRejectedValueOnce(new Error('503 GPU is in use'))
        .mockResolvedValue([[0.1]])
      stats = await generatePendingEmbeddings()
    })

    it('keeps going and finishes without stalling', () => {
      expect(stats.stalled).toBeNull()
      expect(stats.processed).toBe(1)
    })
  })

  describe('when the stand-down switch is thrown', () => {
    it('stops without calling it a stall — yielding is not a failure', async () => {
      servePending([[message(1)]], true)
      shouldStandDownMock.mockResolvedValue(true)
      const stats = await generatePendingEmbeddings()

      expect(stats.stalled).toBeNull()
      expect(generateEmbeddingsMock).not.toHaveBeenCalled()
    })
  })
})
