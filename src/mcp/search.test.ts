import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const querySimilar = vi.fn()
// getEmbeddingsByIds backs the noise-ranking penalty (src/mcp/noise.ts). Empty
// by default: with no noise the penalty is a no-op, which is exactly the state
// every test here is asserting about. src/mcp/noise-search.test.ts covers it.
vi.mock('../db/chroma.js', () => ({
  querySimilar: (...args: unknown[]) => querySimilar(...args),
  getEmbeddingsByIds: vi.fn(async () => new Map()),
}))

// Search embeds its query through the INTERACTIVE client — one attempt, a few
// seconds — because a person is waiting on it. `embed` is a mock so a test can
// make the query vector unavailable, which is what a shut GPU gate looks like
// from here.
const embed = vi.fn(async () => ({ embeddings: [new Array(1024).fill(0.1)] }))
// The signal each search hands the client, so a test can see it abandoned.
const embedSignals: AbortSignal[] = []
vi.mock('../embeddings/ollama.js', () => ({
  getInteractiveOllamaClient: (signal: AbortSignal) => {
    embedSignals.push(signal)
    return { embed: (...args: unknown[]) => embed(...(args as [])) }
  },
}))

// The semantic switch (src/sync/sync-control.ts) is a row in Postgres; on
// unless a test switches it off.
const semanticOn = vi.fn(async () => true)
vi.mock('../sync/sync-control.js', () => ({ semanticEnabled: () => semanticOn() }))

const { search, searchWithDiagnostics, resolveDataClasses, formatSearchResults, findProjectsByPath, NOISE_CHECK, FULL_TEXT_ONLY } =
  await import('./search.js')
const { config } = await import('../config.js')
import type { Adjustment, EvidenceList } from './evidence.js'

type Row = Record<string, unknown>
const rows = (...r: Row[]) => ({ rows: r })
// Hydration asks for every hit of a tier in one query, ids in $1.
const SESSIONS_BY_ID = 's.id = ANY($1'
const rowsForIds = (params: unknown[] | undefined, lookup: (id: number) => Row | undefined) =>
  rows(...(params?.[0] as number[]).flatMap((id): Row[] => { const row = lookup(id); return row ? [row] : [] }))

const sessionRow = (over: Row): Row => ({
  id: 1,
  title: 'A session',
  summary: 'summary',
  project_name: 'proj',
  project_path: '/p/proj',
  source_name: 'claude_code',
  data_class: 'coding',
  started_at: new Date('2026-01-01T00:00:00Z'),
  // A session that saw no further activity: last activity IS its start. Tests
  // that care about the difference set ended_at explicitly.
  ended_at: new Date('2026-01-01T00:00:00Z'),
  message_count: 10,
  project_id: 7,
  ...over,
})

// Two sessions in the index: 1 is an android SMS thread, 2 is a coding session.
const fixtures: Record<number, Row> = {
  1: sessionRow({ id: 1, title: 'SMS thread', source_name: 'android', data_class: 'personal' }),
  2: sessionRow({ id: 2, title: 'Fixing the build', source_name: 'claude_code', data_class: 'coding' }),
}

const mockDbForSemantic = () => {
  query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (typeof sql === 'string' && sql.includes(SESSIONS_BY_ID))
      return rowsForIds(params, (id) => fixtures[id])
    return rows()
  })
}

const mockChromaSessionsOnly = () => {
  querySimilar.mockImplementation(async (collection: string) => {
    if (collection === 'convo-sessions')
      return { ids: [['session-1', 'session-2']], distances: [[0.1, 0.2]] }
    return { ids: [[]], distances: [[]] }
  })
}

beforeEach(() => {
  query.mockReset()
  querySimilar.mockReset()
  embed.mockReset()
  embed.mockResolvedValue({ embeddings: [new Array(1024).fill(0.1)] })
  semanticOn.mockResolvedValue(true)
})

describe('resolveDataClasses', () => {
  it('defaults to coding only', () => {
    expect(resolveDataClasses({})).toEqual(['coding'])
  })

  it('treats an empty dataClass array as the default', () => {
    expect(resolveDataClasses({ dataClass: [] })).toEqual(['coding'])
  })

  it('lets "*" disable the filter entirely', () => {
    expect(resolveDataClasses({ dataClass: ['*'] })).toBeNull()
    expect(resolveDataClasses({ dataClass: ['coding', '*'] })).toBeNull()
  })

  it('honours an explicit class list', () => {
    expect(resolveDataClasses({ dataClass: ['personal', 'meetings'] })).toEqual([
      'personal',
      'meetings',
    ])
  })

  it('bypasses the default when a source is named explicitly', () => {
    expect(resolveDataClasses({ source: 'android' })).toBeNull()
  })

  it('normalizes case and whitespace', () => {
    expect(resolveDataClasses({ dataClass: [' Coding ', 'PERSONAL'] })).toEqual([
      'coding',
      'personal',
    ])
  })

  it('treats blank entries as absent', () => {
    expect(resolveDataClasses({ dataClass: ['', '   '] })).toEqual(['coding'])
  })

  it('still ANDs an explicit dataClass with an explicit source', () => {
    expect(resolveDataClasses({ source: 'android', dataClass: ['personal'] })).toEqual(['personal'])
  })
})

describe('search default data-class filter (semantic arm)', () => {
  it('excludes non-coding sessions by default', async () => {
    mockDbForSemantic()
    mockChromaSessionsOnly()

    const results = await search({ query: 'anything', mode: 'semantic' })
    expect(results.map((r) => r.session_id)).toEqual([2])
    expect(results[0].data_class).toBe('coding')
  })

  it('returns everything when dataClass is ["*"]', async () => {
    mockDbForSemantic()
    mockChromaSessionsOnly()

    const results = await search({ query: 'anything', mode: 'semantic', dataClass: ['*'] })
    expect(results.map((r) => r.session_id).sort()).toEqual([1, 2])
  })

  it('returns android sessions when the source is named explicitly', async () => {
    mockDbForSemantic()
    mockChromaSessionsOnly()

    const results = await search({ query: 'anything', mode: 'semantic', source: 'android' })
    expect(results.map((r) => r.session_id)).toEqual([1])
    expect(results[0].data_class).toBe('personal')
  })

  it('widens to the named classes', async () => {
    mockDbForSemantic()
    mockChromaSessionsOnly()

    const results = await search({
      query: 'anything',
      mode: 'semantic',
      dataClass: ['coding', 'personal'],
    })
    expect(results.map((r) => r.session_id).sort()).toEqual([1, 2])
  })

  it('over-fetches limit*5 from Chroma when the class filter is active', async () => {
    mockDbForSemantic()
    mockChromaSessionsOnly()

    await search({ query: 'anything', mode: 'semantic', limit: 8 })
    expect(querySimilar).toHaveBeenCalledWith('convo-sessions', expect.anything(), 40)
    expect(querySimilar).toHaveBeenCalledWith('convo-chunks', expect.anything(), 40)
    expect(querySimilar).toHaveBeenCalledWith('convo-messages', expect.anything(), 40)
  })

  it('keeps the original over-fetch when the filter is disabled', async () => {
    mockDbForSemantic()
    mockChromaSessionsOnly()

    await search({ query: 'anything', mode: 'semantic', limit: 8, dataClass: ['*'] })
    expect(querySimilar).toHaveBeenCalledWith('convo-sessions', expect.anything(), 16)
    expect(querySimilar).toHaveBeenCalledWith('convo-chunks', expect.anything(), 24)
    expect(querySimilar).toHaveBeenCalledWith('convo-messages', expect.anything(), 24)
  })
})

describe('search default data-class filter (full-text arm)', () => {
  const ftsCall = () =>
    query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('ranked_messages'))
  // Classes are resolved to project ids first; full text filters on the ids.
  const classLookup = () =>
    query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('COALESCE(p.data_class, src.data_class) = ANY($1')
    )

  it('filters to the projects in ["coding"] by default', async () => {
    query.mockImplementation(async (sql: string) =>
      sql.includes('COALESCE(p.data_class, src.data_class) = ANY($1') ? rows({ id: 4 }, { id: 9 }) : rows()
    )

    await search({ query: 'deploy', mode: 'text' })
    expect(classLookup()![1]).toEqual([['coding']])
    const [sql, values] = ftsCall()!
    expect(sql).toContain('s.project_id = ANY(')
    expect(values).toContainEqual([4, 9])
  })

  it('omits the predicate when dataClass is ["*"]', async () => {
    query.mockResolvedValue(rows())

    await search({ query: 'deploy', mode: 'text', dataClass: ['*'] })
    const [sql] = ftsCall()!
    expect(classLookup()).toBeUndefined()
    expect(sql).not.toContain('s.project_id = ANY(')
  })

  it('omits the predicate when an explicit source is given', async () => {
    query.mockResolvedValue(rows())

    await search({ query: 'deploy', mode: 'text', source: 'android' })
    const [sql, values] = ftsCall()!
    expect(classLookup()).toBeUndefined()
    expect(sql).not.toContain('s.project_id = ANY(')
    expect(values).toContain('android')
  })

  it('ANDs an explicit dataClass with an explicit source', async () => {
    query.mockResolvedValue(rows())

    await search({ query: 'deploy', mode: 'text', source: 'android', dataClass: ['personal'] })
    const [sql, values] = ftsCall()!
    expect(sql).toContain('s.project_id = ANY(')
    expect(values).toContain('android')
    expect(classLookup()![1]).toEqual([['personal']])
  })

  it('adds the excludeTerms condition after the class predicate', async () => {
    query.mockResolvedValue(rows())

    await search({ query: 'deploy', mode: 'text', excludeTerms: 'kubernetes' })
    const [sql, values] = ftsCall()!
    expect(sql).toContain('NOT to_tsvector')
    expect(values).toContain('kubernetes')
    expect(classLookup()![1]).toEqual([['coding']])
  })

  it('surfaces an FTS row as a message-tier hit with its headline', async () => {
    query.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('ranked_messages'))
        return rows({
          session_id: 2,
          message_id: 900,
          title: 'Fixing the build',
          project_name: 'proj',
          project_path: '/p/proj',
          source_name: 'claude_code',
          data_class: 'coding',
          started_at: new Date('2026-01-01T00:00:00Z'),
          ended_at: new Date('2026-01-01T00:00:00Z'),
          message_count: 10,
          rank: 0.9,
          project_id: 7,
          headline: 'we **fixed** the build',
        })
      return rows()
    })

    const results = await search({ query: 'fixed', mode: 'text' })
    expect(results).toHaveLength(1)
    expect(results[0].matched_tier).toBe('message')
    expect(results[0].cursor).toEqual({ message_id: 900 })
    expect(results[0].data_class).toBe('coding')
    expect(results[0].snippet).toContain('**fixed**')
  })
})

describe('search parameter arms', () => {
  it('requires a query or a centroid parameter', async () => {
    await expect(search({})).rejects.toThrow(/query or centroid/)
  })

  it('surfaces chunk and message tier hits with cursors', async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('session_chunks'))
        return rows({ ...fixtures[2], chunk_id: 10, chunk_index: 3, chunk_summary: 'the fix section' })
      if (typeof sql === 'string' && sql.includes('WHERE m.id = ANY($1'))
        return rows({ ...fixtures[2], id: 9, message_id: 900, content_text: 'we fixed it here' })
      if (typeof sql === 'string' && sql.includes(SESSIONS_BY_ID))
        return rowsForIds(params, (id) => fixtures[id])
      return rows()
    })
    querySimilar.mockImplementation(async (collection: string) => {
      if (collection === 'convo-chunks') return { ids: [['chunk-10']], distances: [[0.1]] }
      if (collection === 'convo-messages') return { ids: [['msg-900']], distances: [[0.2]] }
      return { ids: [[]], distances: [[]] }
    })

    const results = await search({ query: 'fix', mode: 'semantic' })
    const chunkHit = results.find((r) => r.matched_tier === 'chunk')
    expect(chunkHit?.cursor).toEqual({ chunk_index: 3 })
    expect(chunkHit?.snippet).toBe('the fix section')
    // Session 9 was first claimed by the message arm.
    const messageHit = results.find((r) => r.matched_tier === 'message')
    expect(messageHit?.cursor).toEqual({ message_id: 900 })
  })

  it('boosts sessions from the cwd project and honours projectOnly', async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM projects p') && sql.includes('LIKE'))
        return rows({ id: 7, path: '/p/proj', name: 'proj', source_name: 'claude_code' })
      if (typeof sql === 'string' && sql.includes(SESSIONS_BY_ID))
        return rowsForIds(params, (id) => fixtures[id])
      return rows()
    })
    mockChromaSessionsOnly()

    // Both fixtures live in project 7; projectOnly keeps them, and the boost
    // lifts the score above the bare fusion contribution.
    const results = await search({
      query: 'x',
      mode: 'semantic',
      cwd: '/p/proj/sub',
      projectOnly: true,
      dataClass: ['*'],
    })
    expect(results.map((r) => r.session_id).sort()).toEqual([1, 2])
    for (const r of results) expect(r.score).toBeGreaterThan(0.5)
  })

  it('hands back the projects the cwd resolved to', async () => {
    query.mockImplementation(async (sql: string) =>
      typeof sql === 'string' && sql.includes('FROM projects p') && sql.includes('LIKE')
        ? rows({ id: 7, path: '/p/proj', name: 'proj', source_name: 'claude_code' })
        : rows()
    )
    querySimilar.mockResolvedValue({ ids: [[]], distances: [[]] })
    const outcome = await searchWithDiagnostics({ query: 'x', mode: 'semantic', cwd: '/p/proj/sub' })
    expect(outcome.projectIds).toEqual([7])
  })

  // Both fixtures ended when they started, so there is no recent activity to
  // keep them — see the last-activity suite below for the case where there is.
  it('drops sessions older than since', async () => {
    mockDbForSemantic()
    mockChromaSessionsOnly()

    const results = await search({
      query: 'x',
      mode: 'semantic',
      dataClass: ['*'],
      since: '2026-02-01',
    })
    expect(results).toEqual([])
  })

  it('steers by weighted centroids without a query', async () => {
    const centroid = JSON.stringify(new Array(1024).fill(0.5))
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('centroid_vector FROM sessions'))
        return rows({ centroid_vector: centroid })
      if (typeof sql === 'string' && sql.includes('centroid_vector FROM projects'))
        return rows({ centroid_vector: centroid })
      if (typeof sql === 'string' && sql.includes(SESSIONS_BY_ID))
        return rowsForIds(params, (id) => fixtures[id])
      return rows()
    })
    mockChromaSessionsOnly()

    const results = await search({
      likeSession: ['5:1.5', 'not-a-number'],
      unlikeSession: ['6'],
      likeProject: ['7:0.5'],
      unlikeProject: ['8'],
      negativeQuery: 'briefings',
      query: 'storefronts',
      mode: 'semantic',
    })
    expect(results.map((r) => r.session_id)).toEqual([2])
  })
})

describe('hydrating the semantic hits', () => {
  const coding = (id: number) => sessionRow({ id, title: `session-title-${id}` })
  const chromaOrder = [31, 32, 33]

  // Postgres owes no order to an ANY($1) lookup, so it answers here in the
  // reverse of Chroma's distance order.
  beforeEach(() => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes(SESSIONS_BY_ID))
        return rows(...[...(params?.[0] as number[])].reverse().map(coding))
      if (typeof sql === 'string' && sql.includes('session_chunks'))
        return rows(...[...(params?.[0] as number[])].reverse().map((chunkId) => ({ ...coding(chunkId - 100), chunk_id: chunkId, chunk_index: 0, chunk_summary: 'chunk-summary-velvet' })))
      return rows()
    })
  })

  it('ranks session hits in Chroma distance order, not in the order the rows came back', async () => {
    querySimilar.mockImplementation(async (collection: string) =>
      collection === 'convo-sessions'
        ? { ids: [chromaOrder.map((id) => `session-${id}`)], distances: [[0.1, 0.2, 0.3]] }
        : { ids: [[]], distances: [[]] }
    )
    const results = await search({ query: 'query-text-moonlit-ferret', mode: 'semantic' })
    expect(results.map((r) => r.session_id)).toEqual(chromaOrder)
  })

  it('ranks chunk hits in Chroma distance order, not in the order the rows came back', async () => {
    querySimilar.mockImplementation(async (collection: string) =>
      collection === 'convo-chunks'
        ? { ids: [chromaOrder.map((id) => `chunk-${id + 100}`)], distances: [[0.1, 0.2, 0.3]] }
        : { ids: [[]], distances: [[]] }
    )
    const results = await search({ query: 'query-text-moonlit-ferret', mode: 'semantic' })
    expect(results.map((r) => r.session_id)).toEqual(chromaOrder)
  })

  it('hydrates each tier in one query however many hits it has', async () => {
    querySimilar.mockImplementation(async (collection: string) =>
      collection === 'convo-sessions'
        ? { ids: [chromaOrder.map((id) => `session-${id}`)], distances: [[0.1, 0.2, 0.3]] }
        : { ids: [[]], distances: [[]] }
    )
    await search({ query: 'query-text-moonlit-ferret', mode: 'semantic' })
    expect(query.mock.calls.filter(([sql]) => String(sql).includes(SESSIONS_BY_ID))).toHaveLength(1)
  })
})

describe('when the arms finish out of order', () => {
  const ftsRow = {
    ...fixtures[2],
    session_id: 2,
    message_id: 900,
    rank: 0.9,
    headline: 'headline-text-**gilded**-otter',
  }
  let releaseChroma: () => void
  let chromaPending: boolean

  // Chroma answers only once released; the full-text arm answers at once.
  beforeEach(() => {
    chromaPending = true
    const chromaGate = new Promise<void>((resolve) => {
      releaseChroma = () => {
        chromaPending = false
        resolve()
      }
    })
    querySimilar.mockImplementation(async (collection: string) => {
      await chromaGate
      return collection === 'convo-sessions'
        ? { ids: [['session-2']], distances: [[0.1]] }
        : { ids: [[]], distances: [[]] }
    })
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('ranked_messages')) return rows(ftsRow)
      if (typeof sql === 'string' && sql.includes(SESSIONS_BY_ID)) return rowsForIds(params, (id) => fixtures[id])
      return rows()
    })
  })

  describe('when full text resolves first', () => {
    let results: Awaited<ReturnType<typeof search>>

    beforeEach(async () => {
      const searching = search({ query: 'query-text-gilded-otter', mode: 'hybrid' })
      setTimeout(() => releaseChroma(), 20)
      results = await searching
    })

    it('still lets the session tier claim the session', () => {
      expect(results.map((r) => [r.session_id, r.matched_tier])).toEqual([[2, 'session']])
    })

    it('still upgrades the claimed snippet to the full-text headline', () => {
      expect(results[0].snippet).toContain('**gilded**')
    })
  })

  describe('when the chunk tier fails', () => {
    let outcome: Awaited<ReturnType<typeof searchWithDiagnostics>>

    beforeEach(async () => {
      querySimilar.mockImplementation(async (collection: string) => {
        if (collection === 'convo-chunks') throw new Error('error-chroma-sulking-badger')
        if (collection === 'convo-sessions') return { ids: [['session-2']], distances: [[0.1]] }
        return { ids: [['msg-900']], distances: [[0.1]] }
      })
      query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string' && sql.includes('WHERE m.id = ANY($1'))
          return rows({ ...fixtures[2], id: 9, message_id: 900, content_text: 'message-text-sulking-badger' })
        if (typeof sql === 'string' && sql.includes(SESSIONS_BY_ID)) return rowsForIds(params, (id) => fixtures[id])
        return rows()
      })
      outcome = await searchWithDiagnostics({ query: 'query-text-gilded-otter', mode: 'semantic' })
    })

    it('keeps the tiers before it and drops the ones after it', () => {
      expect(outcome.results.map((r) => [r.session_id, r.matched_tier])).toEqual([[2, 'session']])
    })

    it('reports the failed tier as the reason', () => {
      expect(outcome.degraded?.reason).toBe('error-chroma-sulking-badger')
    })
  })

  it('starts the full-text query without waiting for the semantic arms', async () => {
    const searching = search({ query: 'query-text-gilded-otter', mode: 'hybrid' })
    await vi.waitFor(() => {
      if (!query.mock.calls.some(([sql]) => String(sql).includes('ranked_messages'))) throw new Error('no full-text query yet')
    })
    const startedWhileChromaPending = chromaPending
    releaseChroma()
    await searching
    expect(startedWhileChromaPending).toBe(true)
  })
})

describe('evidence', () => {
  // Session 3 joins the two fixtures, so a tier can rank sessions against each other.
  const sessions: Record<number, Row> = { ...fixtures, 3: sessionRow({ id: 3, title: 'Another coding session' }) }
  const messages: Record<number, Row> = {
    10: { ...sessions[2], message_id: 10, content_text: 'message-text-nearest-heron' },
    11: { ...sessions[2], message_id: 11, content_text: 'message-text-farther-heron' },
    20: { ...sessions[3], message_id: 20, content_text: 'message-text-session-three' },
  }
  const chunks: Record<number, Row> = {
    5: { ...sessions[2], chunk_id: 5, chunk_index: 1, chunk_summary: 'chunk-text-nearest' },
    6: { ...sessions[2], chunk_id: 6, chunk_index: 4, chunk_summary: 'chunk-text-farther' },
  }
  const ftsRow = (sessionId: number, messageId: number): Row => ({
    ...sessions[sessionId],
    session_id: sessionId,
    message_id: messageId,
    rank: 0.25,
    headline: `headline-${messageId}`,
  })
  type Hits = Partial<Record<'convo-sessions' | 'convo-chunks' | 'convo-messages', [string, number][]>>
  // Hydration answers in REVERSE of the order it was asked for, so a tier that
  // walked rows in database order instead of Chroma's order would be caught.
  const serve = (hits: Hits, fullText: Row[] = []) => {
    querySimilar.mockImplementation(async (collection: keyof Hits) => {
      const list = hits[collection] ?? []
      return { ids: [list.map(([id]) => id)], distances: [list.map(([, d]) => d)] }
    })
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const reversed = (lookup: Record<number, Row>) =>
        rows(...[...(params?.[0] as number[])].reverse().flatMap((id) => (lookup[id] ? [lookup[id]] : [])))
      if (sql.includes('ranked_messages')) return rows(...fullText)
      if (sql.includes('FROM messages m') && sql.includes('m.id = ANY($1')) return reversed(messages)
      if (sql.includes('FROM session_chunks c')) return reversed(chunks)
      if (sql.includes(SESSIONS_BY_ID)) return reversed(sessions)
      return rows()
    })
  }

  it('ranks a tier in Chroma order, not the order hydration returned rows', async () => {
    serve({ 'convo-messages': [['msg-10', 0.1], ['msg-20', 0.2]] })
    const results = await search({ query: 'q', mode: 'semantic' })
    expect(results.map((r) => [r.session_id, r.evidence])).toEqual([
      [2, [{ arm: 'message', rank: 1, cosine: 0.9, messageId: 10 }]],
      [3, [{ arm: 'message', rank: 2, cosine: 0.8, messageId: 20 }]],
    ])
  })

  it('keeps the nearest message of a session, not a later one', async () => {
    serve({ 'convo-messages': [['msg-10', 0.1], ['msg-11', 0.3]] })
    const [hit] = await search({ query: 'q', mode: 'semantic' })
    expect(hit.evidence).toEqual([{ arm: 'message', rank: 1, cosine: 0.9, messageId: 10 }])
    expect(hit.cursor).toEqual({ message_id: 10 })
    expect(hit.snippet).toBe('message-text-nearest-heron')
  })

  it('keeps the nearest chunk of a session, not a later one', async () => {
    serve({ 'convo-chunks': [['chunk-5', 0.1], ['chunk-6', 0.3]] })
    const [hit] = await search({ query: 'q', mode: 'semantic' })
    expect(hit.evidence).toEqual([{ arm: 'chunk', rank: 1, cosine: 0.9, chunkIndex: 1 }])
    expect(hit.cursor).toEqual({ chunk_index: 1 })
  })

  it('credits a session to the arm that ranked it best and points there', async () => {
    serve({ 'convo-sessions': [['session-3', 0.1], ['session-2', 0.2]], 'convo-messages': [['msg-10', 0.15]] })
    const results = await search({ query: 'q', mode: 'semantic' })
    const two = results.find((r) => r.session_id === 2)!
    expect(two.evidence.map((e) => [e.arm, e.rank])).toEqual([['message', 1], ['session', 2]])
    expect([two.matched_tier, two.cursor, two.snippet]).toEqual(['message', { message_id: 10 }, 'message-text-nearest-heron'])
  })

  it('breaks an equal rank in arm order: session, chunk, message, then full text', async () => {
    serve({ 'convo-messages': [['msg-10', 0.1]], 'convo-chunks': [['chunk-5', 0.1]] }, [ftsRow(2, 11)])
    const [hit] = await search({ query: 'q', mode: 'hybrid' })
    expect(hit.evidence.map((e) => e.arm)).toEqual(['chunk', 'message', 'lexical'])
    expect(hit.matched_tier).toBe('chunk')
    expect(hit.snippet).toBe('headline-11')
  })

  it('credits full text when it ranked the session best', async () => {
    serve({ 'convo-sessions': [['session-3', 0.1], ['session-2', 0.2]] }, [ftsRow(2, 11)])
    const two = (await search({ query: 'q', mode: 'hybrid' })).find((r) => r.session_id === 2)!
    expect(two.evidence[0]).toEqual({ arm: 'lexical', rank: 1, tsRank: 0.25, messageId: 11 })
    expect([two.matched_tier, two.cursor]).toEqual(['message', { message_id: 11 }])
  })

  // Crediting moves where a result points, never where it ranks.
  it('scores a result by reciprocal rank fusion of every arm, whichever is credited', async () => {
    serve({ 'convo-sessions': [['session-3', 0.1], ['session-2', 0.2]], 'convo-messages': [['msg-10', 0.15]] })
    const results = await search({ query: 'q', mode: 'semantic' })
    expect(results.map((r) => [r.session_id, r.base, r.score])).toEqual([
      [2, 1 / 62 + 1 / 61, 1 / 62 + 1 / 61],
      [3, 1 / 61, 1 / 61],
    ])
  })

  it('records the project boost as an adjustment the score includes', async () => {
    serve({ 'convo-sessions': [['session-2', 0.1], ['session-3', 0.2]] })
    const served = query.getMockImplementation()!
    query.mockImplementation(async (sql: string, params?: unknown[]) =>
      sql.includes('FROM projects p') && sql.includes('LIKE ANY')
        ? rows({ id: 7, path: '/p/proj', name: 'proj', source_name: 'claude_code' })
        : served(sql, params)
    )
    sessions[3] = { ...sessions[3], project_id: 8 }
    const results = await search({ query: 'q', mode: 'semantic', cwd: '/p/proj' })
    sessions[3] = { ...sessions[3], project_id: 7 }
    expect(results.map((r) => [r.session_id, r.adjustments])).toEqual([
      [2, [{ kind: 'project', boost: 0.5 }]],
      [3, []],
    ])
    expect(results[0].score).toBe(results[0].base + 0.5)
  })

  // The mock applies the one predicate Postgres would: a deleted session is
  // returned unless the query excludes it.
  describe.each([
    ['session', 'convo-sessions', 'session-2'],
    ['chunk', 'convo-chunks', 'chunk-5'],
    ['message', 'convo-messages', 'msg-10'],
  ] as const)('the %s tier', (_tier, collection, id) => {
    it('never returns a deleted session', async () => {
      serve({ [collection]: [[id, 0.1]] })
      const served = query.getMockImplementation()!
      query.mockImplementation(async (sql: string, params?: unknown[]) =>
        sql.includes('s.deleted_at IS NULL') ? served(sql, params) : rows()
      )
      expect((await search({ query: 'q', mode: 'semantic' })).map((r) => r.session_id)).toEqual([2])
    })
  })

  describe('with a fixed candidate pool', () => {
    const searchConfig = config.search as { candidatePool: number | null }
    beforeEach(() => {
      searchConfig.candidatePool = 37
    })
    afterEach(() => {
      searchConfig.candidatePool = null
    })

    it.each([1, 8, 100])('asks every arm for the pool size at limit %i', async (limit) => {
      serve({})
      await search({ query: 'q', mode: 'hybrid', limit })
      expect(querySimilar.mock.calls.map(([collection, , n]) => [collection, n]).sort()).toEqual([
        ['convo-chunks', 37],
        ['convo-messages', 37],
        ['convo-sessions', 37],
      ])
      const fullText = query.mock.calls.find(([sql]) => String(sql).includes('ranked_messages'))!
      expect((fullText[1] as unknown[]).at(-1)).toBe(37)
    })
  })

  it('asks for limit-relative pools when none is fixed', async () => {
    serve({})
    await search({ query: 'q', mode: 'hybrid', limit: 4, dataClass: ['*'] })
    expect(querySimilar.mock.calls.map(([collection, , n]) => [collection, n]).sort()).toEqual([
      ['convo-chunks', 12],
      ['convo-messages', 12],
      ['convo-sessions', 8],
    ])
    const fullText = query.mock.calls.find(([sql]) => String(sql).includes('ranked_messages'))!
    expect((fullText[1] as unknown[]).at(-1)).toBe(8)
  })

  it('over-fetches every vector arm fivefold under a data-class filter', async () => {
    serve({})
    await search({ query: 'q', mode: 'semantic', limit: 4 })
    expect(querySimilar.mock.calls.map(([, , n]) => n)).toEqual([20, 20, 20])
  })
})

describe('when full text fails', () => {
  const failFullText = () =>
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('ranked_messages')) throw new Error('error-fts-sulking-heron')
      if (sql.includes(SESSIONS_BY_ID)) return rowsForIds(params, (id) => fixtures[id])
      return rows()
    })

  beforeEach(() => {
    embedSignals.length = 0
  })

  it('abandons the query embedding it was waiting on', async () => {
    failFullText()
    embed.mockImplementation(() => new Promise(() => {}))
    await expect(search({ query: 'q', mode: 'hybrid' })).rejects.toThrow('error-fts-sulking-heron')
    expect(embedSignals.at(-1)?.aborted).toBe(true)
  })

  it('does not hydrate a Chroma answer that arrives afterwards', async () => {
    failFullText()
    let answer!: () => void
    const answered = new Promise<void>((resolve) => (answer = resolve))
    querySimilar.mockImplementation(async () => {
      await answered
      return { ids: [['session-2']], distances: [[0.1]] }
    })
    await expect(search({ query: 'q', mode: 'hybrid' })).rejects.toThrow('error-fts-sulking-heron')
    answer()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(query.mock.calls.filter(([sql]) => String(sql).includes(SESSIONS_BY_ID))).toEqual([])
  })
})

describe('when the session tier fails and the later tiers succeed', () => {
  it('keeps none of the later tiers, and says why', async () => {
    querySimilar.mockImplementation(async (collection: string) => {
      if (collection === 'convo-sessions') throw new Error('error-chroma-sessions-gone')
      if (collection === 'convo-chunks') return { ids: [['chunk-5']], distances: [[0.1]] }
      return { ids: [['msg-10']], distances: [[0.1]] }
    })
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM session_chunks c')) return rows({ ...fixtures[2], chunk_id: 5, chunk_index: 1, chunk_summary: 'c' })
      if (sql.includes('FROM messages m') && sql.includes('m.id = ANY($1')) return rows({ ...fixtures[2], message_id: 10, content_text: 'm' })
      return rows()
    })
    const outcome = await searchWithDiagnostics({ query: 'q', mode: 'semantic' })
    expect(outcome.results).toEqual([])
    expect(outcome.degraded?.reason).toBe('error-chroma-sessions-gone')
  })
})

describe('dataClass validation', () => {
  const withKnownClasses = () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('DISTINCT data_class'))
        return rows({ data_class: 'coding' }, { data_class: 'meetings' }, { data_class: 'personal' })
      if (typeof sql === 'string' && sql.includes(SESSIONS_BY_ID))
        return rowsForIds(params, (id) => fixtures[id])
      return rows()
    })
  }

  it('rejects an unknown class, naming the valid vocabulary', async () => {
    withKnownClasses()
    await expect(search({ query: 'x', mode: 'text', dataClass: ['codign'] })).rejects.toThrow(
      'Unknown dataClass value(s): codign. Valid values: coding, meetings, personal, or "*" for everything.'
    )
  })

  it('accepts a miscased class after normalization instead of returning nothing', async () => {
    withKnownClasses()
    await search({ query: 'x', mode: 'text', dataClass: [' Coding '] })
    const classLookup = query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('COALESCE(p.data_class, src.data_class) = ANY($1')
    )
    expect(classLookup![1]).toEqual([['coding']])
  })

  it('skips validation while the vocabulary is empty (pre-migration)', async () => {
    query.mockResolvedValue(rows())
    await expect(search({ query: 'x', mode: 'text' })).resolves.toEqual([])
  })
})

describe('findProjectsByPath', () => {
  it('returns projects whose path prefixes (or is prefixed by) the cwd', async () => {
    query.mockResolvedValue(
      rows({ id: 7, path: '/p/proj', name: 'proj', source_name: 'claude_code' })
    )
    const projects = await findProjectsByPath('/p/proj/sub')
    expect(projects).toEqual([{ id: 7, path: '/p/proj', name: 'proj', source_name: 'claude_code' }])
    // Ancestors are matched by exact equality, so no stored path is ever used
    // as a LIKE pattern; only the descendant direction is a pattern.
    const [exact, exactLower, under, underLower] = query.mock.calls[0][1] as string[][]
    expect(exact).toEqual(['/p/proj/sub', '/p/proj', '/p', '/'])
    expect(exactLower).toEqual([])
    expect(under).toEqual(['/p/proj/sub/%'])
    expect(underLower).toEqual([])
  })

  it('handles roots and non-path pseudo-projects without inventing ancestors', async () => {
    query.mockResolvedValue(rows())
    await findProjectsByPath('D:/')
    const [exact, exactLower, , underLower] = query.mock.calls[0][1] as string[][]
    expect(exactLower).toEqual(['d:/'])
    expect(exact).toEqual(['/mnt/d', '/mnt', '/'])
    expect(underLower).toEqual(['D:/%'])

    query.mockClear()
    await findProjectsByPath('phone')
    const [pseudoExact, , pseudoUnder] = query.mock.calls[0][1] as string[][]
    expect(pseudoExact).toEqual(['phone'])
    expect(pseudoUnder).toEqual(['phone/%'])
  })

  it('returns nothing for an empty cwd rather than matching everything', async () => {
    query.mockClear()
    expect(await findProjectsByPath('  ')).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it('escapes LIKE wildcards that are legal path characters', async () => {
    query.mockResolvedValue(rows())
    await findProjectsByPath('/p/50%_off/sub')
    const [exact, , under] = query.mock.calls[0][1] as string[][]
    expect(exact).toContain('/p/50%_off')
    expect(under).toEqual([String.raw`/p/50\%\_off/sub/%`])
  })

  it('does not let a shorter project name match a longer directory', async () => {
    // `D:/pro` used to match a cwd of `D:/projects` for want of a separator
    // boundary. Neither the exact list nor the descendant pattern can now.
    query.mockResolvedValue(rows())
    await findProjectsByPath('D:/projects')
    const [exact, exactLower, under, underLower] = query.mock.calls[0][1] as string[][]
    expect(exactLower).not.toContain('d:/pro')
    // The drive spelling is case-insensitive (the `D:` form proves it);
    // the drvfs spelling is generated too but stays case-sensitive on its own.
    expect(exactLower).toEqual(['d:/projects', 'd:/'])
    expect(underLower).toEqual(['D:/projects/%'])
    expect(exact).toEqual(['/mnt/d/projects', '/mnt/d', '/mnt', '/'])
    expect(under).toEqual(['/mnt/d/projects/%'])
  })
})

describe('formatSearchResults', () => {
  const result = (over: Record<string, unknown> = {}) => ({
    session_id: 2,
    project_name: 'proj',
    project_path: '/p/proj',
    source: 'claude_code',
    data_class: 'coding',
    title: 'Fixing the build',
    title_source: 'source' as const,
    date: new Date('2026-01-01T00:00:00Z'),
    score: 0.7,
    matched_tier: 'session' as const,
    snippet: 'we fixed it',
    noise_damping: null,
    evidence: [{ arm: 'session', rank: 1, cosine: 0.7 }] as EvidenceList,
    base: 0.7,
    adjustments: [] as Adjustment[],
    ...over,
  })

  it('says so when nothing matched', () => {
    expect(formatSearchResults([])).toBe('No matching conversations found.')
  })

  it('names the list handle on the first line, and only when there are results', () => {
    expect(formatSearchResults([result()], { list: 'Lk3x9qa' }).split('\n')[0]).toBe(
      'Found 1 relevant conversations (list Lk3x9qa):'
    )
    expect(formatSearchResults([], { list: 'Lk3x9qa' })).not.toContain('Lk3x9qa')
  })

  it('renders source and data class together', () => {
    const text = formatSearchResults([result()])
    expect(text).toContain('(claude_code, coding)')
    expect(text).toContain('Session ID: 2')
    expect(text).toContain('we fixed it')
  })

  // The label used to compare project ids with session ids, so it marked
  // whichever result's session id happened to equal a current project's id.
  it('marks exactly the results the project boost was applied to', () => {
    const text = formatSearchResults([
      result({ session_id: 7, cursor: { chunk_index: 3 } }),
      result({ session_id: 3, adjustments: [{ kind: 'project', boost: 0.5 }], matched_tier: 'message' as const, cursor: { message_id: 900 }, snippet: null }),
    ])
    const [first, second] = text.split(/\n\n2\. /)
    expect(first).not.toContain('[CURRENT PROJECT]')
    expect(second).toContain('[CURRENT PROJECT]')
    expect(text).toContain('Cursor: chunk 3')
    expect(text).toContain('Cursor: message 900')
    expect(text).toContain('(no snippet)')
  })

  it('shows each arm compactly, and the score breakdown only when explain is asked for', () => {
    const scored = result({
      score: 0.5139,
      base: 0.0323,
      matched_tier: 'message' as const,
      evidence: [
        { arm: 'message', rank: 1, cosine: 0.612, messageId: 9 },
        { arm: 'lexical', rank: 2, tsRank: 0.0607, messageId: 9 },
        { arm: 'chunk', rank: 4, cosine: 0.5, chunkIndex: 0 },
      ] as EvidenceList,
      adjustments: [
        { kind: 'noise', similarity: 0.71, factor: 0.43 },
        { kind: 'project', boost: 0.5 },
      ] as Adjustment[],
    })
    const plain = formatSearchResults([scored])
    expect(plain).toContain('Score: 0.514 | Matched: message (message #1 0.61, text #2, chunk #4 0.50)')
    expect(plain).not.toContain('Why:')
    expect(formatSearchResults([scored], { explain: true })).toContain(
      'Why: base 0.0323 | noise ×0.430 (sim 0.71) | project +0.5 | text #2 ts_rank 0.0607'
    )
  })

  describe('noise', () => {
    const below = config.noise.nudgeBelow - 0.05
    const lightlyDamped = (config.noise.nudgeBelow + 1) / 2

    it('shows the damping on each damped result', () => {
      const text = formatSearchResults([result({ noise_damping: 0.8214 })])
      expect(text).toContain('Noise: ×0.821')
    })

    it('shows no damping on clean or unscored results', () => {
      const text = formatSearchResults([result({ noise_damping: 1 }), result({ session_id: 3, noise_damping: null })])
      expect(text).not.toContain('Noise:')
    })

    it('asks for a noise check naming exactly the results below the threshold', () => {
      const text = formatSearchResults([
        result({ session_id: 11, noise_damping: below }),
        result({ session_id: 12, noise_damping: lightlyDamped }),
        result({ session_id: 13, noise_damping: below }),
        result({ session_id: 14, noise_damping: null }),
        result({ session_id: 15, noise_damping: config.noise.nudgeBelow }),
      ])
      const note = text.slice(text.indexOf(NOISE_CHECK))
      expect(note).toMatch(new RegExp(`^${NOISE_CHECK}: sessions 11, 13 resemble`))
      expect(note).toContain('reportUselessSession(sessionId, reason)')
      expect(note).toContain('NEVER report a session just because it is off-topic')
    })

    it('leaves the note out when nothing is damped below the threshold', () => {
      const text = formatSearchResults([
        result({ noise_damping: 1 }),
        result({ session_id: 3, noise_damping: lightlyDamped }),
        result({ session_id: 4, noise_damping: config.noise.nudgeBelow }),
      ])
      expect(text).toContain('Noise: ×')
      expect(text).not.toContain(NOISE_CHECK)
    })

    it('leaves the note out when no result could be scored', () => {
      const text = formatSearchResults([result({ noise_damping: null }), result({ session_id: 3 })])
      expect(text).not.toContain(NOISE_CHECK)
    })
  })
})

// Issue #95: a session's title used to be the first 200 characters of its first
// message, and was never re-derived once a summary existed. Search is the surface
// where that misled an LLM most, because formatSearchResults makes the title the
// bold headline of every hit and never prints the summary.
describe('search title resolution (#95)', () => {
  it('derives the title from the summary when the source supplied none', async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes(SESSIONS_BY_ID))
        return (params?.[0] as number[]).includes(2) ? rows(sessionRow({ id: 2, title: null, summary: 'Fixed the FTS ranking query.\nThen deployed it.' })) : rows()
      return rows()
    })
    mockChromaSessionsOnly()

    const results = await search({ query: 'anything', mode: 'semantic' })
    const hit = results.find(r => r.session_id === 2)
    expect(hit?.title).toBe('Fixed the FTS ranking query.')
    expect(hit?.title_source).toBe('summary')
  })

  // Reachable only via includeUnsummarized, since an unsummarized session is
  // otherwise withheld — but when it is reached, it must not carry a guess.
  it('reports no title rather than inventing one when there is no summary yet', async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes(SESSIONS_BY_ID))
        return (params?.[0] as number[]).includes(2) ? rows(sessionRow({ id: 2, title: null, summary: null })) : rows()
      return rows()
    })
    mockChromaSessionsOnly()

    const results = await search({ query: 'anything', mode: 'semantic', includeUnsummarized: true })
    const hit = results.find(r => r.session_id === 2)
    expect(hit?.title).toBeNull()
    expect(hit?.title_source).toBe('none')
  })

  it('formats an untitled hit as an honest placeholder, not as "Untitled"', () => {
    const formatted = formatSearchResults([
      {
        session_id: 4268,
        project_name: 'proj',
        project_path: '/p/proj',
        source: 'claude_code',
        data_class: 'coding',
        title: null,
        title_source: 'none',
        date: new Date('2026-01-01T00:00:00Z'),
        score: 0.5,
        matched_tier: 'message',
        snippet: 'a matching excerpt',
        noise_damping: null,
        evidence: [{ arm: 'lexical', rank: 1, tsRank: 0.5, messageId: 1 }],
        base: 0.5,
        adjustments: [],
      },
    ])
    expect(formatted).toContain('Session 4268')
    expect(formatted).toContain('not summarized yet')
    expect(formatted).not.toContain('Untitled')
  })
})

// Operator direction on #95: "let's not even surface sessions until they are
// properly summarized and indexed." An unsummarized session has no real title
// and no session-tier vector, so surfacing it puts an untriageable row in front
// of the caller. It is withheld by default and reachable on request.
describe('unsummarized sessions are withheld (#95)', () => {
  it('does not return a session that has no summary', async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes(SESSIONS_BY_ID))
        return (params?.[0] as number[]).includes(2) ? rows(sessionRow({ id: 2, title: null, summary: null })) : rows()
      return rows()
    })
    mockChromaSessionsOnly()

    expect(await search({ query: 'anything', mode: 'semantic' })).toEqual([])
  })

  it('returns it when the caller explicitly asks for unsummarized sessions', async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes(SESSIONS_BY_ID))
        return (params?.[0] as number[]).includes(2) ? rows(sessionRow({ id: 2, title: null, summary: null })) : rows()
      return rows()
    })
    mockChromaSessionsOnly()

    const results = await search({ query: 'anything', mode: 'semantic', includeUnsummarized: true })
    expect(results.map(r => r.session_id)).toEqual([2])
  })

  it('withholds them in the text arm too, not only the semantic arms', async () => {
    query.mockResolvedValue(rows())
    await search({ query: 'anything', mode: 'text' })
    const ftsCall = query.mock.calls.find(c => String(c[0]).includes('ranked_messages'))
    expect(String(ftsCall?.[0])).toContain('s.summary IS NOT NULL')
  })

  it('drops that condition when unsummarized sessions are requested', async () => {
    query.mockResolvedValue(rows())
    await search({ query: 'anything', mode: 'text', includeUnsummarized: true })
    const ftsCall = query.mock.calls.find(c => String(c[0]).includes('ranked_messages'))
    expect(String(ftsCall?.[0])).not.toContain('s.summary IS NOT NULL')
  })
})

// A search runs with someone waiting on it, and the vector arm depends on a GPU
// that is entitled to say "not now". Before this, a shut gate meant ~120s of
// retries inside the shared client and then full-text results handed back with
// no indication anything had been skipped — the caller could not tell "no such
// conversation" from "the semantic half never ran".
// One full-text hit (session 2) and nothing else, which is all a search can
// find when the vector arms are skipped.
const mockFullTextHitOnly = () =>
  query.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('ranked_messages'))
        return rows({
          session_id: 2,
          message_id: 99,
          title: 'Fixing the build',
          summary: 'summary',
          project_name: 'proj',
          project_path: '/p/proj',
          source_name: 'claude_code',
          data_class: 'coding',
          started_at: new Date('2026-01-01T00:00:00Z'),
          message_count: 10,
          rank: 0.9,
          project_id: 7,
          headline: 'the <b>build</b>',
        })
      return rows()
    })

describe('when the query vector cannot be had', () => {
  const gateShut = () => {
    embed.mockRejectedValue(new Error('503 GPU is in use by other applications'))
    mockFullTextHitOnly()
    mockChromaSessionsOnly()
  }

  beforeEach(gateShut)

  it('still returns the full-text results rather than failing', async () => {
    const { results } = await searchWithDiagnostics({ query: 'build', mode: 'hybrid' })
    expect(results.map(r => r.session_id)).toEqual([2])
  })

  it('says the results are degraded, and why', async () => {
    const { degraded } = await searchWithDiagnostics({ query: 'build', mode: 'hybrid' })
    expect(degraded?.semantic).toBe(false)
    expect(degraded?.reason).toContain('GPU is in use')
  })

  // One attempt. The retrying client is for background work that must not be
  // lost; here, waiting out a cooldown is worse than answering now.
  it('does not retry the embedding', async () => {
    await searchWithDiagnostics({ query: 'build', mode: 'hybrid' })
    expect(embed).toHaveBeenCalledTimes(1)
  })

  it('times each stage that ran, and leaves a stage that did not run null', async () => {
    const ran = expect.any(Number)
    const shut = await searchWithDiagnostics({ query: 'build', mode: 'hybrid' })
    expect(shut.armMs).toEqual({ semanticMs: ran, embedMs: ran, sessionMs: null, chunkMs: null, messageMs: null, fullTextMs: ran })
    embed.mockResolvedValue({ embeddings: [new Array(1024).fill(0.1)] })
    const open = await searchWithDiagnostics({ query: 'build', mode: 'hybrid' })
    expect(open.armMs).toEqual({ semanticMs: ran, embedMs: ran, sessionMs: ran, chunkMs: ran, messageMs: ran, fullTextMs: ran })
    const text = await searchWithDiagnostics({ query: 'build', mode: 'text' })
    expect(text.armMs).toEqual({ semanticMs: null, embedMs: null, sessionMs: null, chunkMs: null, messageMs: null, fullTextMs: ran })
  })

  it('reports nothing degraded when the vector arrives', async () => {
    embed.mockResolvedValue({ embeddings: [new Array(1024).fill(0.1)] })
    mockDbForSemantic()
    const { degraded } = await searchWithDiagnostics({ query: 'build', mode: 'semantic' })
    expect(degraded).toBeNull()
  })

  // An LLM reading the rendered text cannot see the server log, and will treat
  // an empty result as proof the conversation does not exist.
  it('warns in the rendered text, including when nothing matched', () => {
    const note = formatSearchResults([], { degraded: { semantic: false, cause: 'unavailable', reason: 'gate shut' } })
    expect(note).toContain(FULL_TEXT_ONLY)
    expect(note).toContain('gate shut')
    expect(note).toContain('Retry shortly')
  })

  it('leaves the rendered text alone on a healthy search', () => {
    expect(formatSearchResults([])).toBe('No matching conversations found.')
  })
})

// Switched off is a choice, not an outage: no vector work at all, and the
// caller is told it was switched off rather than invited to retry a search
// that will degrade the same way until someone switches it back on.
describe('with the semantic switch off', () => {
  beforeEach(() => {
    semanticOn.mockResolvedValue(false)
    mockFullTextHitOnly()
    mockChromaSessionsOnly()
  })

  it('answers from full text without asking Ollama or Chroma anything', async () => {
    const { results } = await searchWithDiagnostics({ query: 'build', mode: 'hybrid' })
    expect(results.map(r => r.session_id)).toEqual([2])
    expect(embed).not.toHaveBeenCalled()
    expect(querySimilar).not.toHaveBeenCalled()
  })

  it('says it was switched off, not that it failed', async () => {
    const { degraded } = await searchWithDiagnostics({ query: 'build', mode: 'semantic' })
    expect(degraded?.cause).toBe('switched-off')
    const note = formatSearchResults([], { degraded })
    expect(note).toContain('switched off')
    expect(note).not.toContain('Retry shortly')
  })

  it('reports nothing degraded for a full-text search, which lost nothing', async () => {
    const { degraded } = await searchWithDiagnostics({ query: 'build', mode: 'text' })
    expect(degraded).toBeNull()
  })
})

// `since` used to filter on s.started_at — the timestamp of the FIRST message
// ever in the session. Session keys are far coarser than conversations (an SMS
// thread keyed on threadId spans years), so a message that arrived minutes ago
// inside an old session read as ancient and was dropped. Observed live: a query
// returning one hit returned ZERO once `since=6h` was added, for a message 18
// minutes old. The same column dated hits by session birth, so a week-old
// message could be rendered as tonight's conversation.
describe('recency is last activity, not first message', () => {
  // The reported shape: a thread that began in 2014 and received a message today.
  const longRunning = sessionRow({
    id: 1,
    title: 'SMS thread',
    source_name: 'android',
    data_class: 'personal',
    started_at: new Date('2014-09-12T00:00:00Z'),
    ended_at: new Date('2026-08-07T23:42:00Z'),
  })

  const onlySession = (row: Row) =>
    query.mockImplementation(async (sql: string) =>
      typeof sql === 'string' && sql.includes(SESSIONS_BY_ID) ? rows(row) : rows()
    )

  const ftsRow = (over: Row): Row => ({
    session_id: 1,
    message_id: 900,
    title: 'SMS thread',
    summary: 'summary',
    project_name: 'proj',
    project_path: '/p/proj',
    source_name: 'android',
    data_class: 'personal',
    started_at: new Date('2014-09-12T00:00:00Z'),
    ended_at: new Date('2026-08-07T23:42:00Z'),
    message_count: 10,
    rank: 0.9,
    project_id: 7,
    headline: 'the <b>courier</b>',
    ...over,
  })

  it('keeps a decade-old session that was active inside the since window', async () => {
    onlySession(longRunning)
    querySimilar.mockImplementation(async (collection: string) =>
      collection === 'convo-sessions'
        ? { ids: [['session-1']], distances: [[0.1]] }
        : { ids: [[]], distances: [[]] }
    )

    const results = await search({
      query: 'courier arriving',
      mode: 'semantic',
      dataClass: ['*'],
      since: '2026-08-07T18:00:00Z',
    })
    expect(results.map(r => r.session_id)).toEqual([1])
  })

  it('still drops a session whose last activity predates the window', async () => {
    onlySession(sessionRow({ id: 1, ended_at: new Date('2026-01-02T00:00:00Z') }))
    mockChromaSessionsOnly()

    const results = await search({
      query: 'courier arriving',
      mode: 'semantic',
      dataClass: ['*'],
      since: '2026-08-07T18:00:00Z',
    })
    expect(results).toEqual([])
  })

  // ended_at is MAX(m.timestamp) and was non-null across every live session, but
  // a session whose stats have not been computed yet must not vanish from every
  // since-filtered search: it falls back to started_at rather than to NULL.
  it('falls back to started_at when the session has no ended_at', async () => {
    onlySession(sessionRow({ id: 1, started_at: new Date('2026-08-07T20:00:00Z'), ended_at: null }))
    mockChromaSessionsOnly()

    const results = await search({
      query: 'courier arriving',
      mode: 'semantic',
      dataClass: ['*'],
      since: '2026-08-07T18:00:00Z',
    })
    expect(results.map(r => r.session_id)).toEqual([1])
  })

  it('dates a semantic hit by its last activity, not its first message', async () => {
    onlySession(longRunning)
    mockChromaSessionsOnly()

    const results = await search({ query: 'courier', mode: 'semantic', dataClass: ['*'] })
    expect(results[0].date).toEqual(new Date('2026-08-07T23:42:00Z'))
  })

  it('dates a full-text hit by its last activity, not its first message', async () => {
    query.mockImplementation(async (sql: string) =>
      typeof sql === 'string' && sql.includes('ranked_messages') ? rows(ftsRow({})) : rows()
    )

    const results = await search({ query: 'courier', mode: 'text', dataClass: ['*'] })
    expect(results[0].date).toEqual(new Date('2026-08-07T23:42:00Z'))
  })

  // The SQL arm has to apply the same rule as passesFilters does in TypeScript;
  // they are the same expression from last-activity.ts precisely so they cannot
  // drift into disagreeing about what "recent" means.
  it('filters the full-text arm on last activity in SQL', async () => {
    query.mockResolvedValue(rows())
    await search({ query: 'courier', mode: 'text', since: '2026-08-07T18:00:00Z' })

    const [sql] = query.mock.calls.find(c => String(c[0]).includes('ranked_messages'))!
    expect(sql).toContain('COALESCE(s.ended_at, s.started_at) >= $3')
    expect(sql).not.toContain('s.started_at >= $3')
  })
})
