import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IngestPayloadSchema } from './ingest-schema.js'

const { query, head } = vi.hoisted(() => {
  const head: { revision: string; content_hash: string; current_session_id: number | null } = { revision: '0', content_hash: '', current_session_id: null }
  return { query: vi.fn(), head }
})
vi.mock('../db/postgres.js', () => ({ transaction: async (operation: (client: { query: typeof query }) => unknown) => operation({ query }) }))
import { ingestSnapshot } from './ingest-snapshot.js'

const payload = (revision = 1) => IngestPayloadSchema.parse({
  mode: 'snapshot', snapshot: { revision, complete: true }, source: 'source-roaming-squid', dataClass: 'slack',
  project: { externalId: 'project-lair', name: 'The Lair' },
  session: { externalId: 'thread-kraken', title: 'The Kraken', startedAt: '2026-01-01T00:00:00Z' },
  messages: [{ externalId: 'message-lantern', role: 'user', content: 'Lantern\u0000', timestamp: '2026-01-01T00:00:00Z', sequenceNum: 0, metadata: { speaker: 'The Kraken', details: { z: 1, a: null }, tags: ['lantern'] } }],
})

beforeEach(() => {
  Object.assign(head, { revision: '0', content_hash: '', current_session_id: null })
  query.mockReset().mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('SELECT id FROM projects')) return { rows: [{ id: 7 }] }
    if (sql.includes('COALESCE(p.data_class')) return { rows: [{ data_class: 'slack' }] }
    if (sql.includes('FOR UPDATE')) return { rows: [{ ...head }] }
    if (sql.includes('INSERT INTO sessions')) return { rows: [{ id: 71 }] }
    if (sql.includes('UPDATE ingest_heads SET revision')) {
      head.revision = String(params[2])
      if (params.length > 3) {
        head.content_hash = String(params[3])
        head.current_session_id = params[4] === null ? null : Number(params[4])
      }
    }
    return { rows: [] }
  })
})

describe('when a complete snapshot is applied', () => {
  let result: unknown
  beforeEach(async () => { result = await ingestSnapshot(7, payload()) })
  it('acknowledges the current version', () => { expect(result).toEqual({ projectId: 7, status: 'applied', revision: 1, sessionId: 71, messagesInserted: 1 }) })
  it('normalizes the stored text', () => {
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO messages'), expect.arrayContaining(['Lantern']))
  })
  describe('when it is replayed', () => {
    beforeEach(async () => { result = await ingestSnapshot(7, payload()) })
    it('acknowledges without inserting again', () => { expect(result).toMatchObject({ status: 'unchanged', messagesInserted: 0 }) })
  })
  describe('when an older request arrives after a newer revision', () => {
    beforeEach(async () => {
      await ingestSnapshot(7, payload(3))
      result = await ingestSnapshot(7, payload(2))
    })
    it('returns the current revision', () => { expect(result).toMatchObject({ status: 'stale', revision: 3, sessionId: 71 }) })
  })
  describe('when the thread is deleted', () => {
    beforeEach(async () => {
      result = await ingestSnapshot(7, { ...payload(2), messages: [] })
    })
    it('returns a tombstone', () => { expect(result).toMatchObject({ status: 'applied', sessionId: null, messagesInserted: 0 }) })
  })
})

describe('when a revision carries conflicting contents', () => {
  let error: unknown
  beforeEach(async () => {
    await ingestSnapshot(7, payload())
    const changed = payload()
    changed.messages[0].content = 'A different lantern'
    error = await ingestSnapshot(7, changed).catch(error => error)
  })
  it('refuses the conflicting revision', () => {
    expect(error).toHaveProperty('message', 'Snapshot revision already contains different content')
  })
})

describe('when the effective project class differs', () => {
  let error: unknown
  beforeEach(async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 7 }] }).mockResolvedValueOnce({ rows: [{ data_class: 'coding' }] })
    error = await ingestSnapshot(7, payload()).catch(error => error)
  })
  it('refuses to cross the class boundary', () => {
    expect(error).toHaveProperty('message', 'Snapshot dataClass must match the stored project class')
  })
})

// Every other writer classifies what it writes; this one stored false (#177).
describe('when a snapshot thread opens like an automated run', () => {
  it('stores it flagged automated', async () => {
    const automated = payload()
    automated.session.title = 'Huddle in #lair: lantern standup'
    await ingestSnapshot(7, automated)
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO sessions'))
    expect(insert?.[1].at(-1)).toBe(true)
  })
})
