import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../db/postgres.js', () => ({ query: db.query }))

const { appearsVerbatim, automatedLike, candidateSessions, corpusStats, realSearches, sessionCard, sessionIdsMatchingPaths, startedAtOf } =
  await import('./corpus.js')

const rows = (r: unknown[]) => ({ rows: r })

beforeEach(() => db.query.mockReset())

describe('candidateSessions', () => {
  // The stored is_automated flag was set at first ingest only (issue #177).
  it('drops sessions that are flagged automated or open like an automated run', async () => {
    db.query
      .mockResolvedValueOnce(rows([{ id: 1 }, { id: 2 }, { id: 3 }]))
      .mockResolvedValueOnce(
        rows([
          { id: 1, is_automated: false, opening: 'You are a curiosity curator. opening-text-plush-wren' },
          { id: 2, is_automated: true, opening: 'opening-text-mild-pike' },
          { id: 3, is_automated: false, opening: 'opening-text-brave-tern' },
        ])
      )
    expect(await candidateSessions(['coding'], 'seed-text-calm-reef', 500, 40)).toEqual([3])
    const [, params] = db.query.mock.calls[0]
    expect(params.slice(0, 4)).toEqual([['coding'], 'seed-text-calm-reef', 500, 40])
  })
})

describe('automatedLike', () => {
  it('asks nothing for no ids', async () => {
    expect(await automatedLike([])).toEqual(new Set())
    expect(db.query).not.toHaveBeenCalled()
  })
})

describe('sessionCard', () => {
  const head = (summary: string | null) =>
    rows([{ title: 'title-sleepy-walrus', summary, data_class: 'coding', path: '/projects/path-quiet-dune', started_at: new Date('2026-02-03T04:05:06Z') }])

  it('assembles the card and tells a raw-transcript summary from a generated one', async () => {
    db.query
      .mockResolvedValueOnce(head('[USER]: raw-transcript-text-dim-lark'))
      .mockResolvedValueOnce(rows([{ summary: 'chunk-summary-frosty-elk' }]))
      .mockResolvedValueOnce(rows([{ role: 'user', text: 'message-frantic-gnome' }]))
    expect(await sessionCard(42)).toEqual({
      sessionId: 42,
      title: 'title-sleepy-walrus',
      summary: '[USER]: raw-transcript-text-dim-lark',
      summaryKind: 'raw',
      dataClass: 'coding',
      projectPath: '/projects/path-quiet-dune',
      startedAt: '2026-02-03T04:05:06.000Z',
      chunkSummaries: ['chunk-summary-frosty-elk'],
      messages: [{ role: 'user', text: 'message-frantic-gnome' }],
    })
  })

  it('labels a generated summary generated and a missing one null', async () => {
    db.query.mockResolvedValueOnce(head('summary-tangled-kite')).mockResolvedValue(rows([]))
    expect((await sessionCard(1))!.summaryKind).toBe('generated')
    db.query.mockReset().mockResolvedValueOnce(head(null)).mockResolvedValue(rows([]))
    expect((await sessionCard(1))!.summaryKind).toBeNull()
  })

  it('returns null for a session that does not exist', async () => {
    db.query.mockResolvedValueOnce(rows([]))
    expect(await sessionCard(404)).toBeNull()
    expect(db.query).toHaveBeenCalledTimes(1)
  })
})

describe('small lookups', () => {
  it('appearsVerbatim reports the hit', async () => {
    db.query.mockResolvedValueOnce(rows([{ hit: true }]))
    expect(await appearsVerbatim(1, 'needle-text-sly-crab')).toBe(true)
  })

  it('startedAtOf maps ids to ISO times and keeps a null start', async () => {
    db.query.mockResolvedValueOnce(rows([{ id: 1, started_at: new Date('2026-01-02T00:00:00Z') }, { id: 2, started_at: null }]))
    expect(await startedAtOf([1, 2])).toEqual(new Map([[1, '2026-01-02T00:00:00.000Z'], [2, null]]))
    expect(await startedAtOf([])).toEqual(new Map())
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('sessionIdsMatchingPaths matches nothing for no patterns, without asking', async () => {
    expect(await sessionIdsMatchingPaths([])).toEqual([])
    expect(db.query).not.toHaveBeenCalled()
    db.query.mockResolvedValueOnce(rows([{ id: 8 }]))
    expect(await sessionIdsMatchingPaths(['%pattern-gusty-fern%'])).toEqual([8])
  })

  it('corpusStats turns the count strings postgres returns into numbers', async () => {
    db.query.mockResolvedValueOnce(rows([{ max_session_id: '900', sessions: '850' }]))
    expect(await corpusStats()).toEqual({ max_session_id: 900, sessions: 850 })
  })
})

describe('realSearches', () => {
  const at = new Date('2026-03-10T12:00:00Z')
  const call = (toolUseId: string, input: Record<string, unknown>, listed: number[], opened: string[] | null) => ({
    tool_use_id: toolUseId,
    session_id: 500,
    at,
    input,
    result_text: listed.map((id) => `Session ID: ${id}`).join('\n'),
    opened,
  })
  const recover = async (...calls: ReturnType<typeof call>[]) => {
    db.query.mockResolvedValueOnce(rows(calls))
    return realSearches()
  }

  it('replays what the agent passed and credits only listed sessions it opened', async () => {
    const [search] = await recover(
      call('tool-use-1', { query: ' query-text-velvet-anchor ', dataClass: 'personal', cwd: '/projects/cwd-lucky-newt', projectOnly: true, mode: 'hybrid' }, [11, 12], ['12', '99', '12'])
    )
    expect(search).toMatchObject({
      toolUseId: 'tool-use-1',
      transcriptSessionId: 500,
      text: 'query-text-velvet-anchor',
      dataClass: ['personal'],
      originalMode: 'hybrid',
      replay: { cwd: '/projects/cwd-lucky-newt', projectOnly: true, since: undefined },
      listed: [11, 12],
      opened: [12],
    })
  })

  // "7d" meant seven days before the agent searched, not before today.
  it('resolves a relative since against the time of the original search', async () => {
    const [search] = await recover(call('t', { query: 'query-text-brisk-gull', since: '7d' }, [1], ['1']))
    expect(search.replay.since).toBe('2026-03-03T12:00:00.000Z')
  })

  it('resolves an ISO duration since against the time of the original search', async () => {
    const [search] = await recover(call('t', { query: 'query-text-brisk-gull', since: 'P2D' }, [1], ['1']))
    expect(Math.abs(new Date(search.replay.since!).getTime() - new Date('2026-03-08T12:00:00Z').getTime())).toBeLessThan(1000)
  })

  it('keeps an absolute epoch since as that instant', async () => {
    const [search] = await recover(call('t', { query: 'query-text-brisk-gull', since: '1767225600' }, [1], ['1']))
    expect(search.replay.since).toBe('2026-01-01T00:00:00.000Z')
  })

  it('resolves a natural-language since against the time of the original search', async () => {
    const [search] = await recover(call('t', { query: 'query-text-brisk-gull', since: 'yesterday' }, [1], ['1']))
    expect(search.replay.since!.startsWith('2026-03-09')).toBe(true)
  })

  it('skips a search whose since cannot be parsed', async () => {
    expect(await recover(call('t', { query: 'query-text-brisk-gull', since: 'zzqx-not-a-time' }, [1], ['1']))).toEqual([])
  })

  it('skips searches with parameters replay cannot reproduce', async () => {
    expect(await recover(call('t', { query: 'query-text-brisk-gull', likeSession: ['3'] }, [1], ['1']))).toEqual([])
  })

  it('skips an empty query', async () => {
    expect(await recover(call('t', { query: '   ' }, [1], ['1']))).toEqual([])
  })

  it('keeps the first of repeated queries, ignoring case', async () => {
    const found = await recover(
      call('first', { query: 'Query-Text-Brisk-Gull' }, [1], ['1']),
      call('second', { query: 'query-text-brisk-gull' }, [2], ['2'])
    )
    expect(found.map((s) => s.toolUseId)).toEqual(['first'])
  })

  // An unopened search has no gold; it must not shadow a later identical one that does.
  it('does not let a search nobody opened from shadow a later identical one', async () => {
    const found = await recover(
      call('unopened', { query: 'query-text-brisk-gull' }, [1], null),
      call('opened', { query: 'query-text-brisk-gull', dataClass: ['coding', 'notes'] }, [1], ['1'])
    )
    expect(found.map((s) => [s.toolUseId, s.dataClass, s.originalMode])).toEqual([['opened', ['coding', 'notes'], 'default']])
  })
})
