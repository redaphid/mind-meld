import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock, queriesMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  queriesMock: {
    getSourceByName: vi.fn(),
    getOrCreateSource: vi.fn(),
    upsertProject: vi.fn(),
    upsertSession: vi.fn(),
    insertMessage: vi.fn(),
    updateSessionStats: vi.fn(),
  },
}))

vi.mock('../db/postgres.js', () => ({
  query: queryMock,
  queries: queriesMock,
}))

// ingest.ts pulls listKnownDataClasses from search.ts, which transitively
// imports the chroma and ollama clients; stub them out like search.test.ts
// does so no real client module loads.
vi.mock('../db/chroma.js', () => ({ querySimilar: vi.fn() }))
vi.mock('../embeddings/ollama.js', () => ({ getOllamaClient: vi.fn() }))

const { IngestPayloadSchema, ingestConversation, MissingDataClassError } = await import('./ingest.js')

const payload = (over: Record<string, unknown> = {}) =>
  IngestPayloadSchema.parse({
    source: 'huddle',
    project: { externalId: 'C01', name: '#platform-team' },
    session: { externalId: 'huddle-1', title: 'Rollout sync', startedAt: '2026-07-30T14:30:00Z' },
    messages: [
      {
        externalId: 'huddle-1-0',
        role: 'user',
        content: 'before or after the migration?',
        timestamp: '2026-07-30T14:30:12Z',
        sequenceNum: 0,
      },
    ],
    ...over,
  })

beforeEach(() => {
  queryMock.mockReset()
  for (const fn of Object.values(queriesMock)) fn.mockReset()
  // Vocabulary in use, for the error message.
  queryMock.mockResolvedValue({
    rows: [{ data_class: 'coding' }, { data_class: 'meetings' }, { data_class: 'personal' }],
    rowCount: 3,
  })
  queriesMock.getSourceByName.mockResolvedValue(null)
  queriesMock.getOrCreateSource.mockResolvedValue({ id: 5, name: 'huddle', data_class: 'meetings' })
  queriesMock.upsertProject.mockResolvedValue(7)
  queriesMock.upsertSession.mockResolvedValue(11)
  queriesMock.insertMessage.mockResolvedValue(101)
  queriesMock.updateSessionStats.mockResolvedValue(undefined)
})

describe('IngestPayloadSchema dataClass', () => {
  it('normalizes case and whitespace like the search side', () => {
    expect(payload({ dataClass: ' Meetings ' }).dataClass).toBe('meetings')
  })

  it('treats an empty string as absent', () => {
    expect(payload({ dataClass: '' }).dataClass).toBeUndefined()
  })
})

describe('ingestConversation', () => {
  it('rejects an unclassified ingest that would create a new source', async () => {
    await expect(ingestConversation(payload())).rejects.toBeInstanceOf(MissingDataClassError)
    expect(queriesMock.getOrCreateSource).not.toHaveBeenCalled()
    expect(queriesMock.insertMessage).not.toHaveBeenCalled()
  })

  it('names the source and the classes in use in the error', async () => {
    const error = await ingestConversation(payload()).catch((e) => e)
    expect(error.message).toContain('"huddle"')
    expect(error.message).toContain('coding, meetings, personal')
  })

  it('says so when nothing is classified yet, instead of an empty list', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
    const error = await ingestConversation(payload()).catch((e) => e)
    expect(error).toBeInstanceOf(MissingDataClassError)
    expect(error.message).not.toMatch(/Classes in use: \./)
  })

  it('creates a new source when the class is supplied', async () => {
    const result = await ingestConversation(payload({ dataClass: 'meetings' }))
    expect(queriesMock.getOrCreateSource).toHaveBeenCalledWith('huddle', undefined, 'meetings')
    expect(result).toEqual({
      sourceId: 5,
      projectId: 7,
      sessionId: 11,
      messagesInserted: 1,
      dataClass: 'meetings',
    })
  })

  it('accepts an unclassified ingest into an existing source — its class is already set', async () => {
    queriesMock.getSourceByName.mockResolvedValue({ id: 5, name: 'huddle', base_path: '' })
    const result = await ingestConversation(payload())
    expect(result.dataClass).toBe('meetings')
    expect(queriesMock.getOrCreateSource).toHaveBeenCalledWith('huddle', undefined, undefined)
  })

  it('reports the stored class, not the requested one, for an existing source', async () => {
    // getOrCreateSource never updates data_class on conflict; the response
    // must reflect what the index actually holds.
    queriesMock.getSourceByName.mockResolvedValue({ id: 5, name: 'huddle', base_path: '' })
    queriesMock.getOrCreateSource.mockResolvedValue({ id: 5, name: 'huddle', data_class: 'meetings' })
    const result = await ingestConversation(payload({ dataClass: 'coding' }))
    expect(result.dataClass).toBe('meetings')
  })

  it('counts only messages that were actually inserted', async () => {
    queriesMock.insertMessage.mockResolvedValueOnce(101).mockResolvedValueOnce(null)
    const twoMessages = payload({
      dataClass: 'meetings',
      messages: [
        { externalId: 'a', role: 'user', content: 'x', timestamp: '2026-07-30T14:30:12Z', sequenceNum: 0 },
        { externalId: 'b', role: 'user', content: 'y', timestamp: '2026-07-30T14:30:13Z', sequenceNum: 1 },
      ],
    })
    const result = await ingestConversation(twoMessages)
    expect(result.messagesInserted).toBe(1)
    expect(queriesMock.updateSessionStats).toHaveBeenCalledWith(11)
  })

  it('passes the sender machine and OS through, and null when unknown', async () => {
    await ingestConversation(payload({ dataClass: 'meetings', machine: 'laptop', os: 'wsl' }))
    expect(queriesMock.upsertProject).toHaveBeenCalledWith(5, 'C01', '', '#platform-team', 'laptop', 'wsl')
    expect(queriesMock.upsertSession).toHaveBeenCalledWith(expect.objectContaining({ os: 'wsl' }))
    // A relay that does not know the sender's OS must record null, not this
    // server's own OS — the thread did not come from here (#33).
    await ingestConversation(payload({ dataClass: 'meetings' }))
    expect(queriesMock.upsertProject).toHaveBeenLastCalledWith(5, 'C01', '', '#platform-team', null, null)
    expect(queriesMock.upsertSession).toHaveBeenLastCalledWith(expect.objectContaining({ os: null }))
  })
})
