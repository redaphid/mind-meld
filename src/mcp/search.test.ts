import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const querySimilar = vi.fn()
vi.mock('../db/chroma.js', () => ({ querySimilar: (...args: unknown[]) => querySimilar(...args) }))

vi.mock('../embeddings/ollama.js', () => ({
  getOllamaClient: () => ({
    embed: async () => ({ embeddings: [new Array(1024).fill(0.1)] }),
  }),
}))

const { search, resolveDataClasses } = await import('./search.js')

type Row = Record<string, unknown>
const rows = (...r: Row[]) => ({ rows: r })

const sessionRow = (over: Row): Row => ({
  id: 1,
  title: 'A session',
  summary: 'summary',
  project_name: 'proj',
  project_path: '/p/proj',
  source_name: 'claude_code',
  data_class: 'coding',
  started_at: new Date('2026-01-01T00:00:00Z'),
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
    if (typeof sql === 'string' && sql.includes('s.id = $1')) {
      const row = fixtures[params?.[0] as number]
      return row ? rows(row) : rows()
    }
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

  it('adds the effective-class predicate with ["coding"] by default', async () => {
    query.mockResolvedValue(rows())

    await search({ query: 'deploy', mode: 'text' })
    const call = ftsCall()
    expect(call).toBeDefined()
    const [sql, values] = call!
    expect(sql).toContain(`COALESCE(p.data_class, src.data_class) = ANY(`)
    expect(values).toContainEqual(['coding'])
  })

  it('omits the predicate when dataClass is ["*"]', async () => {
    query.mockResolvedValue(rows())

    await search({ query: 'deploy', mode: 'text', dataClass: ['*'] })
    const [sql] = ftsCall()!
    expect(sql).not.toContain('COALESCE(p.data_class, src.data_class) = ANY(')
  })

  it('omits the predicate when an explicit source is given', async () => {
    query.mockResolvedValue(rows())

    await search({ query: 'deploy', mode: 'text', source: 'android' })
    const [sql, values] = ftsCall()!
    expect(sql).not.toContain('COALESCE(p.data_class, src.data_class) = ANY(')
    expect(values).toContain('android')
  })

  it('ANDs an explicit dataClass with an explicit source', async () => {
    query.mockResolvedValue(rows())

    await search({ query: 'deploy', mode: 'text', source: 'android', dataClass: ['personal'] })
    const [sql, values] = ftsCall()!
    expect(sql).toContain(`COALESCE(p.data_class, src.data_class) = ANY(`)
    expect(values).toContain('android')
    expect(values).toContainEqual(['personal'])
  })
})
