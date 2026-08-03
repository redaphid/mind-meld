import { describe, it, expect, vi, beforeEach } from 'vitest'

// Session re-embedding staleness (#93).
//
// `content_chars_at_embed` records what was embedded. The selection query used
// to treat it as a high-water mark (`>`), so a session whose content SHRANK was
// never re-selected and Chroma kept serving a vector for text that no longer
// existed. These tests pin both directions: a shrunk session must be re-embedded,
// and an unchanged one must not be — because a difference test that re-fires on
// unchanged sessions would be an infinite re-embed loop, worse than the bug.

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../db/postgres.js', () => ({ query, queries: {} }))

const { getEmbeddingMetadata, upsertEmbeddings, addEmbeddings, getCollection } = vi.hoisted(() => ({
  getEmbeddingMetadata: vi.fn(),
  upsertEmbeddings: vi.fn(),
  addEmbeddings: vi.fn(),
  getCollection: vi.fn(),
}))
vi.mock('../db/chroma.js', () => ({
  getEmbeddingMetadata,
  upsertEmbeddings,
  addEmbeddings,
  getCollection,
}))

const { generateEmbeddings, ensureEmbeddingModel } = vi.hoisted(() => ({
  generateEmbeddings: vi.fn(),
  ensureEmbeddingModel: vi.fn(),
}))
vi.mock('./ollama.js', () => ({ generateEmbeddings, ensureEmbeddingModel }))

const { summarizeConversation, ensureSummarizeModel, combineSummaries } = vi.hoisted(() => ({
  summarizeConversation: vi.fn(),
  ensureSummarizeModel: vi.fn(),
  combineSummaries: vi.fn(),
}))
vi.mock('./summarize.js', () => ({
  summarizeConversation,
  ensureSummarizeModel,
  combineSummaries,
}))

const { persistSessionChunks } = vi.hoisted(() => ({ persistSessionChunks: vi.fn() }))
vi.mock('./chunks.js', () => ({ persistSessionChunks }))

// markUnembeddable is deliberately NOT imported here: it is reached through the
// batch below, and importing it directly would retire a knip baseline entry that
// has nothing to do with this change.
const { updateAggregateEmbeddings, generatePendingEmbeddings } = await import('./batch.js')

// One message, so the recomputed size is easy to state exactly:
// the embed path counts the `[ROLE]: ` prefix it prepends before summarizing.
const MESSAGE = { id: 1, role: 'user', content_text: 'hello' }
const RECOMPUTED_CHARS = '[USER]: hello'.length // 13

const session = (overrides: Record<string, unknown>) => ({
  id: 42,
  external_id: 'session-uuid',
  title: 'A session',
  project_path: '/projects/example',
  source_name: 'claude_code',
  message_count: 1,
  total_tokens: 100,
  content_chars: 3000,
  started_at: new Date('2026-01-01T00:00:00Z'),
  existing_content_chars: 5000,
  ...overrides,
})

const isSessionSelect = (sql: string) => sql.includes('existing_content_chars')
const isMessageSelect = (sql: string) => sql.includes('ORDER BY sequence_num')
// Must not also match getMessagesToEmbed, whose anti-join mentions the same column.
const isHealableCount = (sql: string) => sql.includes('SELECT COUNT(*) as count FROM embeddings')

// Everything the batch reads returns empty unless a test says otherwise. The
// healing counter is the one query that dereferences its first row, so it always
// answers with a number.
const emptyDatabase = async (sql: string) => {
  if (isHealableCount(sql)) return { rows: [{ count: '0' }] }
  return { rows: [] }
}

// Drive the batch with a single candidate row, as though the query had selected it.
const withCandidate = (row: ReturnType<typeof session>, messages = [MESSAGE]) => {
  query.mockImplementation(async (sql: string) => {
    if (isSessionSelect(sql)) return { rows: [row] }
    if (isMessageSelect(sql)) return { rows: messages }
    return emptyDatabase(sql)
  })
}

const selectSql = () => query.mock.calls.find(([sql]) => isSessionSelect(sql as string))![0] as string

// The `UPDATE sessions ... content_chars` and the embeddings upsert are what the
// NEXT pass's predicate compares. Pull both back out to prove they agree.
const sessionContentCharsWritten = () =>
  query.mock.calls.find(([sql]) => (sql as string).includes('UPDATE sessions SET summary'))?.[1] as
    | unknown[]
    | undefined

const watermarkWritten = () =>
  query.mock.calls.find(
    ([sql]) =>
      (sql as string).includes('INSERT INTO embeddings') &&
      (sql as string).includes('content_chars_at_embed')
  )?.[1] as unknown[] | undefined

beforeEach(() => {
  query.mockReset()
  query.mockImplementation(emptyDatabase)
  ensureEmbeddingModel.mockReset()
  ensureEmbeddingModel.mockResolvedValue(undefined)
  getEmbeddingMetadata.mockReset()
  getEmbeddingMetadata.mockResolvedValue(null)
  upsertEmbeddings.mockReset()
  upsertEmbeddings.mockResolvedValue(undefined)
  generateEmbeddings.mockReset()
  generateEmbeddings.mockResolvedValue([[0.1, 0.2, 0.3]])
  summarizeConversation.mockReset()
  summarizeConversation.mockResolvedValue('a summary of the conversation')
  combineSummaries.mockReset()
  ensureSummarizeModel.mockReset()
  ensureSummarizeModel.mockResolvedValue(undefined)
  persistSessionChunks.mockReset()
  persistSessionChunks.mockResolvedValue(null)
})

describe('updateAggregateEmbeddings selection predicate', () => {
  it('asks for sessions whose content CHANGED, not only those that grew', async () => {
    await updateAggregateEmbeddings()

    // `IS DISTINCT FROM` catches shrink, growth and a NULL watermark alike.
    expect(selectSql()).toContain('s.content_chars IS DISTINCT FROM e.content_chars_at_embed')
  })

  it('no longer treats content_chars_at_embed as a high-water mark', async () => {
    await updateAggregateEmbeddings()

    // The exact comparison that made a shrunk session invisible forever.
    expect(selectSql()).not.toMatch(/s\.content_chars\s*>\s*COALESCE\(\s*e\.content_chars_at_embed/)
  })
})

describe('a session whose content shrank', () => {
  // The bug: content_chars 3000 < content_chars_at_embed 5000, and Chroma still
  // holds the 5000-char vector. Before the fix this was never re-embedded — the
  // query skipped it, and the Chroma `>=` shortcut skipped it again if it did not.
  const shrunk = () => session({ content_chars: 3000, existing_content_chars: 5000 })

  it('is re-embedded rather than left serving a vector for text that is gone', async () => {
    withCandidate(shrunk())
    getEmbeddingMetadata.mockResolvedValue({ content_chars: 5000 })

    const stats = await updateAggregateEmbeddings()

    expect(upsertEmbeddings).toHaveBeenCalledTimes(1)
    expect(stats.sessionsReembedded).toBe(1)
  })

  it('is not swallowed by the Chroma shortcut just because Chroma holds MORE chars', async () => {
    withCandidate(shrunk())
    getEmbeddingMetadata.mockResolvedValue({ content_chars: 5000 })

    await updateAggregateEmbeddings()

    // It must actually summarize and embed the current text, not sync the old count.
    expect(summarizeConversation).toHaveBeenCalledTimes(1)
    expect(generateEmbeddings).toHaveBeenCalledTimes(1)
  })

  it('writes the same size to the session and the watermark, so the next pass is quiet', async () => {
    withCandidate(shrunk())
    getEmbeddingMetadata.mockResolvedValue({ content_chars: 5000 })

    await updateAggregateEmbeddings()

    // This is what stops `IS DISTINCT FROM` becoming an infinite re-embed loop:
    // both sides of the next comparison are written to the freshly measured size.
    expect(sessionContentCharsWritten()).toEqual([
      'a summary of the conversation',
      RECOMPUTED_CHARS,
      42,
    ])
    expect(watermarkWritten()).toContain(RECOMPUTED_CHARS)
    expect(watermarkWritten()).not.toContain(5000)
  })
})

describe('a session whose content is unchanged', () => {
  // The other direction, and the one that keeps the fix from being worse than the
  // bug: content_chars equal to what Chroma already embedded must NOT re-embed.
  it('is left alone instead of being re-embedded on every pass', async () => {
    withCandidate(session({ content_chars: 5000, existing_content_chars: 5000 }))
    getEmbeddingMetadata.mockResolvedValue({ content_chars: 5000 })

    const stats = await updateAggregateEmbeddings()

    expect(summarizeConversation).not.toHaveBeenCalled()
    expect(generateEmbeddings).not.toHaveBeenCalled()
    expect(upsertEmbeddings).not.toHaveBeenCalled()
    expect(stats.sessionsReembedded).toBe(0)
    expect(stats.sessionsUpdated).toBe(0)
  })
})

describe('a session whose content grew', () => {
  // Unchanged behaviour, pinned so the shrink fix cannot regress it.
  it('is still re-embedded', async () => {
    withCandidate(session({ content_chars: 9000, existing_content_chars: 5000 }))
    getEmbeddingMetadata.mockResolvedValue({ content_chars: 5000 })

    const stats = await updateAggregateEmbeddings()

    expect(upsertEmbeddings).toHaveBeenCalledTimes(1)
    expect(stats.sessionsReembedded).toBe(1)
  })
})

describe('a session with nothing embeddable', () => {
  // Without this the session is selected forever: it can never satisfy the
  // predicate by being embedded, so it has to be stamped as processed instead.
  it('is stamped as processed so it leaves the pending queue', async () => {
    withCandidate(session({ content_chars: 3000, existing_content_chars: 5000 }), [])

    const stats = await updateAggregateEmbeddings()

    // Stamped at zero chars, and the watermark written to match, so the row is
    // settled rather than selected again on every pass.
    expect(sessionContentCharsWritten()).toEqual(['No embeddable content', 0, 42])
    expect(watermarkWritten()).toContain(0)
    expect(generateEmbeddings).not.toHaveBeenCalled()
    expect(stats.sessionsReembedded).toBe(0)
  })
})

describe('updateAggregateEmbeddings failure handling', () => {
  it('marks the session processed when the embedder returns nothing usable', async () => {
    withCandidate(session({}))
    generateEmbeddings.mockResolvedValue([null])

    await updateAggregateEmbeddings()

    // Stamped rather than retried forever, and Chroma is left untouched.
    expect(upsertEmbeddings).not.toHaveBeenCalled()
    expect(sessionContentCharsWritten()).toEqual(['Embedding generation failed', 13, 42])
  })

  it('stops retrying a session whose summary the model refuses', async () => {
    withCandidate(session({}))
    summarizeConversation.mockRejectedValue(new Error('Summary too short: 3 chars'))

    await updateAggregateEmbeddings()

    // A refusal is deterministic — retrying it every cycle just burns the budget.
    const [summary] = sessionContentCharsWritten() as [string, number, number]
    expect(summary).toContain('[unsummarizable]')
  })

  it('leaves a session alone when it fails for any other reason, so the batch continues', async () => {
    withCandidate(session({}))
    summarizeConversation.mockRejectedValue(new Error('ollama is unreachable'))

    const stats = await updateAggregateEmbeddings()

    // No stamp: a transient failure must stay in the queue for the next pass.
    expect(sessionContentCharsWritten()).toBeUndefined()
    expect(stats.sessionsFetched).toBe(1)
  })

  it('embeds a session that has no title or start time', async () => {
    withCandidate(session({ title: null, started_at: null }))

    await updateAggregateEmbeddings()

    const [, payload] = upsertEmbeddings.mock.calls[0] as [string, { metadatas: [Record<string, unknown>] }]
    expect(payload.metadatas[0].title).toBe('')
    expect(typeof payload.metadatas[0].started_at).toBe('number')
  })
})

// A message worth embedding: real prose, comfortably over the noise floor.
const pendingMessage = (overrides: Record<string, unknown> = {}) => ({
  id: 501,
  session_id: 42,
  content_text:
    'A real message about how the embedding pipeline decides what to store, long enough to clear the noise floor.',
  role: 'user',
  timestamp: new Date('2026-01-01T00:00:00Z'),
  project_path: '/projects/example',
  source_name: 'claude_code',
  model: 'a-model',
  ...overrides,
})

const isPendingSelect = (sql: string) => sql.includes('LEFT JOIN embeddings skip')

// Serve the pending batch exactly once; the drain loop asks until it comes back empty.
const withPending = (
  rows: Array<ReturnType<typeof pendingMessage>>,
  extra: (sql: string) => { rows: unknown[]; rowCount?: number } | null = () => null
) => {
  let served = false
  query.mockImplementation(async (sql: string) => {
    const override = extra(sql)
    if (override) return override
    if (isPendingSelect(sql)) {
      if (served) return { rows: [] }
      served = true
      return { rows }
    }
    return emptyDatabase(sql)
  })
}

describe('generatePendingEmbeddings', () => {
  it('stops instead of looping when the queue is empty', async () => {
    const stats = await generatePendingEmbeddings()

    expect(stats).toEqual({ processed: 0, skipped: 0, errors: 0 })
    expect(generateEmbeddings).not.toHaveBeenCalled()
  })

  it('counts NaN-blocked messages against the configured healing window', async () => {
    await generatePendingEmbeddings()

    const healing = query.mock.calls.find(([sql]) => isHealableCount(sql as string))
    expect(healing).toBeDefined()
    // Retry limit and cooldown are bound, not inlined — the healing window is
    // configuration, not a constant baked into the SQL.
    expect((healing![1] as unknown[]).length).toBe(2)
  })

  it('reports a non-empty healing backlog', async () => {
    query.mockImplementation(async (sql: string) =>
      isHealableCount(sql) ? { rows: [{ count: '3' }] } : emptyDatabase(sql)
    )

    const stats = await generatePendingEmbeddings()

    expect(stats.processed).toBe(0)
  })

  it('embeds a pending message into Chroma and records it in Postgres', async () => {
    withPending([pendingMessage()])

    const stats = await generatePendingEmbeddings()

    expect(stats.processed).toBe(1)
    const [, payload] = upsertEmbeddings.mock.calls[0] as [string, { ids: string[] }]
    expect(payload.ids).toEqual(['msg-501'])
    const recorded = query.mock.calls.find(
      ([sql]) => (sql as string).includes('INSERT INTO embeddings') && (sql as string).includes('summarize_model')
    )
    expect(recorded).toBeDefined()
  })

  it('records noise as unembeddable instead of re-judging it every batch', async () => {
    withPending([pendingMessage({ content_text: 'ok' })])

    const stats = await generatePendingEmbeddings()

    expect(generateEmbeddings).not.toHaveBeenCalled()
    expect(stats.processed).toBe(0)
    const marked = query.mock.calls.find(
      ([sql]) => (sql as string).includes('UNEMBEDDABLE') && (sql as string).includes('INSERT INTO embeddings')
    )
    expect(marked).toBeDefined()
    expect((marked![1] as unknown[])[2]).toBe('noise')
  })

  it('marks a message unembeddable when every embedding fallback returns NaN', async () => {
    withPending([pendingMessage()])
    generateEmbeddings.mockResolvedValue([null])

    const stats = await generatePendingEmbeddings()

    expect(stats.skipped).toBe(1)
    expect(stats.processed).toBe(0)
    const marked = query.mock.calls.find(
      ([sql]) => (sql as string).includes('UNEMBEDDABLE') && (sql as string).includes('INSERT INTO embeddings')
    )
    expect((marked![1] as unknown[])[2]).toBe('nan')
  })

  it('summarizes a message too long to embed directly, and records that it did', async () => {
    // Over MAX_EMBED_CHARS: the raw text cannot go to the embedder, so it is
    // summarized first and the summarizing model is recorded alongside the vector.
    withPending([pendingMessage({ content_text: 'a long conversation turn. '.repeat(400) })])

    const stats = await generatePendingEmbeddings()

    expect(summarizeConversation).toHaveBeenCalledTimes(1)
    expect(generateEmbeddings).toHaveBeenCalledWith(['a summary of the conversation'])
    expect(stats.processed).toBe(1)
    const recorded = query.mock.calls.find(
      ([sql]) => (sql as string).includes('INSERT INTO embeddings') && (sql as string).includes('summarize_model')
    )
    expect((recorded![1] as unknown[])[6]).not.toBeNull()
  })

  it('holds a message back for retry when summarization returns almost nothing', async () => {
    withPending([pendingMessage({ content_text: 'a long conversation turn. '.repeat(400) })])
    summarizeConversation.mockResolvedValue('too short')

    const stats = await generatePendingEmbeddings()

    // Nothing embedded and nothing marked — it stays pending rather than being
    // stored against a summary that says nothing.
    expect(generateEmbeddings).not.toHaveBeenCalled()
    expect(stats.processed).toBe(0)
    expect(stats.skipped).toBe(0)
  })

  it('counts a failed batch instead of aborting the run', async () => {
    withPending([pendingMessage()])
    upsertEmbeddings.mockRejectedValue(new Error('chroma is down'))

    const stats = await generatePendingEmbeddings()

    expect(stats.errors).toBe(1)
    expect(stats.processed).toBe(0)
  })

  it('clears UNEMBEDDABLE rows for messages that have since been healed', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM embeddings')) return { rows: [], rowCount: 4 }
      return emptyDatabase(sql)
    })

    await generatePendingEmbeddings()

    const cleanup = query.mock.calls.find(([sql]) => (sql as string).includes('DELETE FROM embeddings'))
    expect(cleanup).toBeDefined()
  })
})
