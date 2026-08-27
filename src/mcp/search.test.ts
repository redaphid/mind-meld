import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const querySimilar = vi.fn()
vi.mock('../db/chroma.js', () => ({ querySimilar: (...args: unknown[]) => querySimilar(...args) }))

// Search embeds its query through the INTERACTIVE client — one attempt, a few
// seconds — because a person is waiting on it. `embed` is a mock so a test can
// make the query vector unavailable, which is what a shut GPU gate looks like
// from here.
const embed = vi.fn(async () => ({ embeddings: [new Array(1024).fill(0.1)] }))
vi.mock('../embeddings/ollama.js', () => ({
  getInteractiveOllamaClient: () => ({ embed: (...args: unknown[]) => embed(...(args as [])) }),
}))

const { search, searchWithDiagnostics, resolveDataClasses, formatSearchResults, findProjectsByPath } =
  await import('./search.js')

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
  embed.mockReset()
  embed.mockResolvedValue({ embeddings: [new Array(1024).fill(0.1)] })
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

  it('adds the excludeTerms condition after the class predicate', async () => {
    query.mockResolvedValue(rows())

    await search({ query: 'deploy', mode: 'text', excludeTerms: 'kubernetes' })
    const [sql, values] = ftsCall()!
    expect(sql).toContain('NOT to_tsvector')
    expect(values).toContain('kubernetes')
    expect(values).toContainEqual(['coding'])
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
        return rows({ ...fixtures[2], chunk_index: 3, chunk_summary: 'the fix section' })
      if (typeof sql === 'string' && sql.includes('WHERE m.id = $1'))
        return rows({ ...fixtures[2], id: 9, message_id: 900, content_text: 'we fixed it here' })
      if (typeof sql === 'string' && sql.includes('s.id = $1')) {
        const row = fixtures[params?.[0] as number]
        return row ? rows(row) : rows()
      }
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
      if (typeof sql === 'string' && sql.includes('s.id = $1')) {
        const row = fixtures[params?.[0] as number]
        return row ? rows(row) : rows()
      }
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
      if (typeof sql === 'string' && sql.includes('s.id = $1')) {
        const row = fixtures[params?.[0] as number]
        return row ? rows(row) : rows()
      }
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

describe('dataClass validation', () => {
  const withKnownClasses = () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('DISTINCT data_class'))
        return rows({ data_class: 'coding' }, { data_class: 'meetings' }, { data_class: 'personal' })
      if (typeof sql === 'string' && sql.includes('s.id = $1')) {
        const row = fixtures[params?.[0] as number]
        return row ? rows(row) : rows()
      }
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
    const ftsCall = query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('ranked_messages')
    )
    expect(ftsCall![1]).toContainEqual(['coding'])
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
    ...over,
  })

  it('says so when nothing matched', () => {
    expect(formatSearchResults([])).toBe('No matching conversations found.')
  })

  it('renders source and data class together', () => {
    const text = formatSearchResults([result()])
    expect(text).toContain('(claude_code, coding)')
    expect(text).toContain('Session ID: 2')
    expect(text).toContain('we fixed it')
  })

  it('marks current-project hits and renders cursors', () => {
    const text = formatSearchResults(
      [
        result({ session_id: 2, cursor: { chunk_index: 3 } }),
        result({ session_id: 3, matched_tier: 'message' as const, cursor: { message_id: 900 }, snippet: null }),
      ],
      [2]
    )
    expect(text).toContain('[CURRENT PROJECT]')
    expect(text).toContain('Cursor: chunk 3')
    expect(text).toContain('Cursor: message 900')
    expect(text).toContain('(no snippet)')
  })
})

// Issue #95: a session's title used to be the first 200 characters of its first
// message, and was never re-derived once a summary existed. Search is the surface
// where that misled an LLM most, because formatSearchResults makes the title the
// bold headline of every hit and never prints the summary.
describe('search title resolution (#95)', () => {
  it('derives the title from the summary when the source supplied none', async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('s.id = $1'))
        return params?.[0] === 2
          ? rows(sessionRow({ id: 2, title: null, summary: 'Fixed the FTS ranking query.\nThen deployed it.' }))
          : rows()
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
      if (typeof sql === 'string' && sql.includes('s.id = $1'))
        return params?.[0] === 2 ? rows(sessionRow({ id: 2, title: null, summary: null })) : rows()
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
      if (typeof sql === 'string' && sql.includes('s.id = $1'))
        return params?.[0] === 2 ? rows(sessionRow({ id: 2, title: null, summary: null })) : rows()
      return rows()
    })
    mockChromaSessionsOnly()

    expect(await search({ query: 'anything', mode: 'semantic' })).toEqual([])
  })

  it('returns it when the caller explicitly asks for unsummarized sessions', async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('s.id = $1'))
        return params?.[0] === 2 ? rows(sessionRow({ id: 2, title: null, summary: null })) : rows()
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
describe('when the query vector cannot be had', () => {
  const gateShut = () => {
    embed.mockRejectedValue(new Error('503 GPU is in use by other applications'))
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

  it('reports nothing degraded when the vector arrives', async () => {
    embed.mockResolvedValue({ embeddings: [new Array(1024).fill(0.1)] })
    mockDbForSemantic()
    const { degraded } = await searchWithDiagnostics({ query: 'build', mode: 'semantic' })
    expect(degraded).toBeNull()
  })

  // An LLM reading the rendered text cannot see the server log, and will treat
  // an empty result as proof the conversation does not exist.
  it('warns in the rendered text, including when nothing matched', () => {
    const note = formatSearchResults([], [], { semantic: false, reason: 'gate shut' })
    expect(note).toContain('full-text results only')
    expect(note).toContain('gate shut')
  })

  it('leaves the rendered text alone on a healthy search', () => {
    expect(formatSearchResults([])).toBe('No matching conversations found.')
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
      typeof sql === 'string' && sql.includes('s.id = $1') ? rows(row) : rows()
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
