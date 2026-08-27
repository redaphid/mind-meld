import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { ingestMock, quarantineMock } = vi.hoisted(() => ({
  ingestMock: vi.fn(),
  quarantineMock: vi.fn(),
}))

// ingest.ts drags in the Postgres client and (via search.ts) the chroma and
// ollama clients; the drain only needs the one function.
vi.mock('../mcp/ingest.js', () => ({ ingestConversation: ingestMock }))
vi.mock('./quarantine.js', () => ({
  quarantine: quarantineMock,
  SPOOL_QUARANTINE_SOURCE: 'ingest_spool',
}))

const { drainIngestSpool } = await import('./ingest-spool.js')

// A payload the shared schema accepts — the same shape ingest.test.ts uses.
const validPayload = JSON.stringify({
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
})

const fetchMock = vi.fn()

// One spool interaction, scripted: what the list returns, then per-object
// responses keyed by method+path suffix.
const respond = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  ingestMock.mockReset()
  quarantineMock.mockReset()
  process.env.INGEST_SPOOL_URL = 'https://gateway.example.com/ingest/mindmeld'
  process.env.INGEST_SPOOL_CLIENT_ID = 'id.access'
  process.env.INGEST_SPOOL_CLIENT_SECRET = 'secret'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INGEST_SPOOL_URL
  delete process.env.INGEST_SPOOL_CLIENT_ID
  delete process.env.INGEST_SPOOL_CLIENT_SECRET
})

describe('drainIngestSpool configuration', () => {
  it('does nothing when the spool env is absent', async () => {
    delete process.env.INGEST_SPOOL_URL
    const stats = await drainIngestSpool()
    expect(stats).toEqual({ configured: false, drained: 0, quarantined: 0, errors: [] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('drainIngestSpool draining', () => {
  it('ingests, acknowledges, and stops on the empty listing', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { keys: [{ id: 'a.json' }], truncated: false }))
      .mockResolvedValueOnce(respond(200, validPayload))
      .mockResolvedValueOnce(respond(204))
      .mockResolvedValueOnce(respond(200, { keys: [], truncated: false }))
    ingestMock.mockResolvedValue({})

    const stats = await drainIngestSpool()

    expect(stats.drained).toBe(1)
    expect(stats.errors).toEqual([])
    expect(ingestMock).toHaveBeenCalledOnce()
    // The parsed payload, not the raw string, reaches ingestConversation.
    expect(ingestMock.mock.calls[0][0].source).toBe('huddle')
    const deleteCall = fetchMock.mock.calls[2]
    expect(deleteCall[0]).toBe('https://gateway.example.com/ingest/mindmeld/spool/a.json')
    expect(deleteCall[1].method).toBe('DELETE')
  })

  it('sends the service token headers on every request', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { keys: [], truncated: false }))
    await drainIngestSpool()
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'CF-Access-Client-Id': 'id.access',
      'CF-Access-Client-Secret': 'secret',
    })
  })

  it('skips objects another worker drained first (404 on fetch)', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { keys: [{ id: 'gone.json' }], truncated: false }))
      .mockResolvedValueOnce(respond(404))
    const stats = await drainIngestSpool()
    expect(stats).toMatchObject({ drained: 0, quarantined: 0, errors: [] })
  })

  it('records an error and returns when the listing fails', async () => {
    fetchMock.mockResolvedValueOnce(respond(500))
    const stats = await drainIngestSpool()
    expect(stats.errors).toEqual(['ingest spool list failed: HTTP 500'])
  })

  // A truncated page must not leave its tail for the next cycle — the loop
  // re-lists until the spool comes back empty.
  it('keeps listing until the spool is empty', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { keys: [{ id: 'a.json' }], truncated: true }))
      .mockResolvedValueOnce(respond(200, validPayload))
      .mockResolvedValueOnce(respond(204))
      .mockResolvedValueOnce(respond(200, { keys: [{ id: 'b.json' }], truncated: false }))
      .mockResolvedValueOnce(respond(200, validPayload))
      .mockResolvedValueOnce(respond(204))
      .mockResolvedValueOnce(respond(200, { keys: [], truncated: false }))
    ingestMock.mockResolvedValue({})

    const stats = await drainIngestSpool()

    expect(stats.drained).toBe(2)
    expect(stats.errors).toEqual([])
  })
})

// The spool lives behind a tunnel and an Access edge, so every request can fail
// in two different ways — an HTTP status, or no response at all. Neither may
// lose an object: what is not acknowledged stays in R2 for the next cycle.
describe('drainIngestSpool transport failures', () => {
  it('records the spool being unreachable when the listing never answers', async () => {
    fetchMock.mockRejectedValueOnce(new Error('tunnel down'))

    const stats = await drainIngestSpool()

    expect(stats).toMatchObject({ configured: true, drained: 0, quarantined: 0 })
    expect(stats.errors[0]).toContain('ingest spool unreachable')
    expect(stats.errors[0]).toContain('tunnel down')
  })

  // One object erroring is not the page erroring: the rest of the listing is
  // still drainable, and leaving it for the next cycle delays real data.
  it('records a failed object fetch and carries on with the rest of the page', async () => {
    fetchMock
      .mockResolvedValueOnce(
        respond(200, { keys: [{ id: 'bad.json' }, { id: 'ok.json' }], truncated: false })
      )
      .mockResolvedValueOnce(respond(500))
      .mockResolvedValueOnce(respond(200, validPayload))
      .mockResolvedValueOnce(respond(204))
      .mockResolvedValueOnce(respond(200, { keys: [], truncated: false }))
    ingestMock.mockResolvedValue({})

    const stats = await drainIngestSpool()

    expect(stats.drained).toBe(1)
    expect(stats.errors).toEqual(['ingest spool fetch of bad.json failed: HTTP 500'])
    // bad.json was never ingested and never acknowledged, so it waits in R2.
    expect(ingestMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls.filter(c => c[1]?.method === 'DELETE')).toHaveLength(1)
  })

  // A dead transport will kill every remaining object the same way; one error
  // is the useful report, a page of identical ones is noise.
  it('stops the pass when the transport dies mid-page', async () => {
    fetchMock
      .mockResolvedValueOnce(
        respond(200, { keys: [{ id: 'a.json' }, { id: 'b.json' }], truncated: false })
      )
      .mockRejectedValueOnce(new Error('socket hang up'))

    const stats = await drainIngestSpool()

    expect(stats.errors).toHaveLength(1)
    expect(stats.errors[0]).toContain('ingest spool unreachable')
    // Two calls total: the listing and the one fetch that died. b.json was not
    // attempted.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// Acknowledging is the last step and the only one whose failure is survivable
// by design: the conversation is already in Postgres, so a lost DELETE costs a
// re-ingest that the upsert keys absorb.
describe('drainIngestSpool acknowledgement', () => {
  it('counts the drain but records a failed acknowledge', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { keys: [{ id: 'a.json' }], truncated: false }))
      .mockResolvedValueOnce(respond(200, validPayload))
      .mockResolvedValueOnce(respond(500))
    ingestMock.mockResolvedValue({})

    const stats = await drainIngestSpool()

    expect(stats.drained).toBe(1)
    expect(stats.errors).toEqual(['ingest spool acknowledge of a.json failed: HTTP 500'])
    // The pass made no progress, so it ends rather than re-listing the same
    // object forever.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  // Another worker already acknowledged it. That is the outcome we wanted, not
  // an error — and it counts as progress so the loop keeps going.
  it('treats a 404 from the acknowledge as done', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { keys: [{ id: 'a.json' }], truncated: false }))
      .mockResolvedValueOnce(respond(200, validPayload))
      .mockResolvedValueOnce(respond(404))
      .mockResolvedValueOnce(respond(200, { keys: [], truncated: false }))
    ingestMock.mockResolvedValue({})

    const stats = await drainIngestSpool()

    expect(stats.drained).toBe(1)
    expect(stats.errors).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('stops the pass when the acknowledge never answers', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { keys: [{ id: 'a.json' }], truncated: false }))
      .mockResolvedValueOnce(respond(200, validPayload))
      .mockRejectedValueOnce(new Error('connection reset'))
    ingestMock.mockResolvedValue({})

    const stats = await drainIngestSpool()

    // Ingested, so the data is safe; the object stays spooled and next cycle
    // re-ingests it onto the same keys.
    expect(stats.drained).toBe(1)
    expect(stats.errors[0]).toContain('ingest spool unreachable')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('drainIngestSpool failure handling', () => {
  it('quarantines a schema-invalid payload as parse and still acknowledges', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { keys: [{ id: 'bad.json' }], truncated: false }))
      .mockResolvedValueOnce(respond(200, '{"not":"a payload"}'))
      .mockResolvedValueOnce(respond(204))
      .mockResolvedValueOnce(respond(200, { keys: [], truncated: false }))
    quarantineMock.mockResolvedValue(42)

    const stats = await drainIngestSpool()

    expect(stats.quarantined).toBe(1)
    expect(ingestMock).not.toHaveBeenCalled()
    expect(quarantineMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'ingest_spool', recordKey: 'bad.json', stage: 'parse' })
    )
    // Quarantined whole and confirmed written, so the spool copy goes.
    expect(fetchMock.mock.calls[2][1].method).toBe('DELETE')
  })

  it('quarantines an ingest failure as insert', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { keys: [{ id: 'a.json' }], truncated: false }))
      .mockResolvedValueOnce(respond(200, validPayload))
      .mockResolvedValueOnce(respond(204))
      .mockResolvedValueOnce(respond(200, { keys: [], truncated: false }))
    ingestMock.mockRejectedValue(new Error('dataClass is required'))
    quarantineMock.mockResolvedValue(43)

    const stats = await drainIngestSpool()

    expect(stats.quarantined).toBe(1)
    expect(quarantineMock).toHaveBeenCalledWith(expect.objectContaining({ stage: 'insert' }))
  })

  it('leaves the object in the spool when even quarantine fails', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { keys: [{ id: 'a.json' }], truncated: false }))
      .mockResolvedValueOnce(respond(200, '{"not":"a payload"}'))
    quarantineMock.mockResolvedValue(null)

    const stats = await drainIngestSpool()

    expect(stats.quarantined).toBe(0)
    expect(stats.errors).toHaveLength(1)
    // No DELETE happened: the failing pass made no progress, so the loop
    // ended rather than spinning on the same object forever.
    expect(fetchMock.mock.calls.filter(c => c[1]?.method === 'DELETE')).toHaveLength(0)
  })
})
