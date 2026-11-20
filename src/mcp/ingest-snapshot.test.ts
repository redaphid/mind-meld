import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closePool, query } from '../db/postgres.js'
import { ingestConversation, IngestPayloadSchema } from './ingest.js'
import { search } from './search.js'
import { getMessageById, getMessages, getSessionDigest } from './session.js'

const vectors = vi.hoisted(() => new Map<string, string[]>())
vi.mock('../db/chroma.js', () => ({
  querySimilar: async (collection: string) => ({ ids: [vectors.get(collection) ?? []], distances: [(vectors.get(collection) ?? []).map(() => 0.1)] }),
  getEmbeddingsByIds: async () => new Map(),
}))
vi.mock('../embeddings/ollama.js', () => ({
  getInteractiveOllamaClient: () => ({ embed: async () => ({ embeddings: [new Array(1024).fill(0.1)] }) }),
}))

const snapshot = (thread: string, revision: number, content: string | null = 'The kraken repairs the lantern') => IngestPayloadSchema.parse({
  mode: 'snapshot', snapshot: { revision, complete: true },
  source: 'source-roaming-squid', dataClass: 'slack',
  project: { externalId: 'project-lair', name: 'The Lair' },
  session: { externalId: thread, title: 'The Kraken', startedAt: '2026-01-01T00:00:00Z' },
  messages: content === null ? [] : [{ externalId: 'message-lantern', role: 'user', content, timestamp: '2026-01-01T00:00:00Z', sequenceNum: 0 }],
})

describe.skipIf(process.env.SNAPSHOT_TEST_DATABASE !== '1')('when complete snapshots reach PostgreSQL', () => {
  let thread: string
  beforeEach(() => { thread = `thread-${randomUUID()}`; vectors.clear() })
  afterAll(closePool)

  describe('when Slack content is searched', () => {
    let visible: Awaited<ReturnType<typeof search>>
    let visibleId: number | null
    let hidden: unknown[]
    beforeEach(async () => {
      const word = `lantern${thread.replaceAll('-', '')}`
      const inserted = await ingestConversation(snapshot(thread, 1, word))
      visible = await search({ query: word, mode: 'text', dataClass: ['slack'] })
      hidden = await search({ query: word, mode: 'text' })
      visibleId = inserted.sessionId
    })
    it('includes the requested Slack class', () => { expect(visible.map(hit => hit.session_id)).toEqual([visibleId]) })
    it('excludes Slack from default coding search', () => { expect(hidden).toEqual([]) })
  })

  describe.each(['convo-sessions', 'convo-chunks', 'convo-messages'])('when stale vectors remain in %s', collection => {
    let hits: Awaited<ReturnType<typeof search>>
    let currentId: number | null
    beforeEach(async () => {
      const first = await ingestConversation(snapshot(thread, 1))
      const messages = await query<{ id: number }>('SELECT id FROM messages WHERE session_id = $1', [first.sessionId])
      const chunk = await query<{ id: number }>(
        'INSERT INTO session_chunks (session_id, chunk_index, summary, start_message_id, end_message_id, content_chars) VALUES ($1, 0, $2, $3, $3, 20) RETURNING id',
        [first.sessionId, 'The old lantern', messages.rows[0].id]
      )
      currentId = (await ingestConversation(snapshot(thread, 2, 'The new lantern'))).sessionId
      const currentMessage = await query<{ id: number }>('SELECT id FROM messages WHERE session_id = $1', [currentId])
      const currentChunk = await query<{ id: number }>(
        'INSERT INTO session_chunks (session_id, chunk_index, summary, start_message_id, end_message_id, content_chars) VALUES ($1, 0, $2, $3, $3, 20) RETURNING id',
        [currentId, 'The new lantern', currentMessage.rows[0].id]
      )
      const candidates: Record<string, string[]> = {
        'convo-sessions': [`session-${first.sessionId}`, `session-${currentId}`],
        'convo-chunks': [`chunk-${chunk.rows[0].id}`, `chunk-${currentChunk.rows[0].id}`],
        'convo-messages': [`msg-${messages.rows[0].id}`, `msg-${currentMessage.rows[0].id}`],
      }
      vectors.set(collection, candidates[collection])
      hits = await search({ query: 'lantern', mode: 'semantic', dataClass: ['slack'] })
    })
    it('hydrates only the current snapshot', () => { expect(hits.map(hit => hit.session_id)).toEqual([currentId]) })
  })

  describe.each(['window', 'range', 'inferred-range'])('when a superseded thread is read through %s', mode => {
    let items: unknown[]
    beforeEach(async () => {
      const first = await ingestConversation(snapshot(thread, 1))
      const message = await query<{ id: string }>('SELECT id FROM messages WHERE session_id = $1', [first.sessionId])
      const id = Number(message.rows[0].id)
      await ingestConversation(snapshot(thread, 2))
      await ingestConversation(snapshot(thread, 3, null))
      const params = mode === 'window' ? { sessionId: first.sessionId! } : {
        sessionId: mode === 'range' ? first.sessionId! : undefined, startMessageId: id, endMessageId: id,
      }
      items = (await getMessages(params))?.items ?? []
    })
    it('returns no superseded message content', () => { expect(items).toEqual([]) })
  })

  describe('when projects share a path and thread external ID', () => {
    let ids: number[]
    beforeEach(async () => {
      const first = snapshot(thread, 1)
      first.project = { externalId: `project-one-${thread}`, name: 'The Lantern', path: '/shared/lantern' }
      const second = { ...first, project: { ...first.project, externalId: `project-two-${thread}` } }
      ids = [(await ingestConversation(first)).projectId, (await ingestConversation(second)).projectId]
    })
    it('keeps their logical identities separate', () => { expect(new Set(ids).size).toBe(2) })
  })

  describe.each(['stale', 'conflict', 'failed-insert'])('when a %s snapshot proposes project metadata', mode => {
    let metadata: unknown
    beforeEach(async () => {
      const initial = snapshot(thread, 2)
      initial.project = { externalId: `project-${thread}`, name: 'The Lantern', path: '/original/lantern' }
      const first = await ingestConversation(initial)
      const revision = mode === 'stale' ? 1 : mode === 'conflict' ? 2 : 3
      const changed = { ...snapshot(thread, revision, 'Changed lantern'), project: { ...initial.project, name: 'The Kraken', path: '/changed/kraken' } }
      if (mode === 'failed-insert') changed.messages[0].role = 'r'.repeat(21)
      await ingestConversation(changed).catch(() => undefined)
      metadata = (await query('SELECT name, path FROM projects WHERE id = $1', [first.projectId])).rows[0]
    })
    it('preserves the accepted project metadata', () => { expect(metadata).toEqual({ name: 'The Lantern', path: '/original/lantern' }) })
  })

  describe('when a revision is replayed', () => {
    let results: Awaited<ReturnType<typeof ingestConversation>>[]
    beforeEach(async () => { results = await Promise.all([ingestConversation(snapshot(thread, 1)), ingestConversation(snapshot(thread, 1))]) })
    it('inserts its messages once under contention', () => { expect(results.map(r => r.messagesInserted).sort()).toEqual([0, 1]) })
    it('returns one current session', () => { expect(new Set(results.map(r => r.sessionId)).size).toBe(1) })
  })

  describe('when A changes to B and returns to A', () => {
    let first: Awaited<ReturnType<typeof ingestConversation>>
    let current: Awaited<ReturnType<typeof ingestConversation>>
    let oldMessage: Awaited<ReturnType<typeof getMessageById>>
    let oldDigest: Awaited<ReturnType<typeof getSessionDigest>>
    let active: unknown[]
    beforeEach(async () => {
      first = await ingestConversation(snapshot(thread, 1))
      const messages = await query<{ id: number }>('SELECT id FROM messages WHERE session_id = $1', [first.sessionId])
      await ingestConversation(snapshot(thread, 2, 'The kraken replaces the lantern'))
      current = await ingestConversation(snapshot(thread, 3))
      oldMessage = await getMessageById(messages.rows[0].id)
      oldDigest = await getSessionDigest({ sessionId: first.sessionId! })
      active = (await query('SELECT id FROM sessions WHERE project_id = $1 AND deleted_at IS NULL AND id = ANY($2)', [first.projectId, [first.sessionId, current.sessionId]])).rows
    })
    it('does not revive the old session', () => { expect(current.sessionId).not.toBe(first.sessionId) })
    it('hides the old message from raw reads', () => { expect(oldMessage).toBeNull() })
    it('hides the old digest', () => { expect(oldDigest).toBeNull() })
    it('keeps the new session active', () => { expect(active).toEqual([{ id: current.sessionId }]) })
  })

  describe('when a newer revision contains identical normalized content', () => {
    let first: Awaited<ReturnType<typeof ingestConversation>>
    let current: Awaited<ReturnType<typeof ingestConversation>>
    beforeEach(async () => {
      first = await ingestConversation(snapshot(thread, 1, 'Lantern\u0000'))
      current = await ingestConversation(snapshot(thread, 2, 'Lantern'))
    })
    it('advances without inserting', () => { expect(current).toMatchObject({ status: 'unchanged', revision: 2, sessionId: first.sessionId, messagesInserted: 0 }) })
  })

  describe('when an older revision races a newer revision', () => {
    let head: unknown
    beforeEach(async () => {
      await Promise.all([ingestConversation(snapshot(thread, 7)), ingestConversation(snapshot(thread, 8, 'A newer lantern'))])
      head = await ingestConversation(snapshot(thread, 6))
    })
    it('retains the newest revision', () => { expect(head).toMatchObject({ status: 'stale', revision: 8, messagesInserted: 0 }) })
  })

  describe('when a revision is reused for different content', () => {
    let error: unknown
    beforeEach(async () => {
      await ingestConversation(snapshot(thread, 1))
      error = await ingestConversation(snapshot(thread, 1, 'Different lantern')).catch(error => error)
    })
    it('rejects the conflict', () => { expect(error).toHaveProperty('message', 'Snapshot revision already contains different content') })
  })

  describe('when the complete thread is empty', () => {
    let result: unknown
    let old: unknown
    beforeEach(async () => {
      const first = await ingestConversation(snapshot(thread, 1))
      result = await ingestConversation(snapshot(thread, 2, null))
      old = await getSessionDigest({ sessionId: first.sessionId! })
    })
    it('acknowledges a tombstone', () => { expect(result).toMatchObject({ status: 'applied', revision: 2, sessionId: null, messagesInserted: 0 }) })
    it('hides the previous session', () => { expect(old).toBeNull() })
  })

  describe('when a later message fails to insert', () => {
    let result: unknown
    beforeEach(async () => {
      await ingestConversation(snapshot(thread, 1))
      const invalid = snapshot(thread, 2)
      invalid.messages.push({ ...invalid.messages[0], externalId: 'message-broken', role: 'r'.repeat(21), sequenceNum: 1 })
      await ingestConversation(invalid).catch(() => undefined)
      result = await ingestConversation(snapshot(thread, 1))
    })
    it('rolls back the head and predecessor changes', () => { expect(result).toMatchObject({ status: 'unchanged', revision: 1 }) })
  })
})
