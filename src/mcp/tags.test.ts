import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn(async (..._args: unknown[]) => ({ rows: [], rowCount: 0 }))
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => query(...(args as [])),
}))

// Mutable, because the point of the default-excluded set is that it is
// configuration rather than a literal. Tests change it to prove the code reads
// it on every call instead of capturing it once at module load.
const mockConfig = { tags: { defaultExcluded: ['useless'] } }
vi.mock('../config.js', () => ({ config: mockConfig }))

const {
  normalizeTag,
  normalizeTags,
  resolveExcludedTags,
  passesTagFilter,
  emptyTagFilter,
  resolveTagFilter,
  applyTags,
  removeTags,
  getTags,
  getSessionTags,
  formatTagWrite,
} = await import('./tags.js')

beforeEach(() => {
  vi.clearAllMocks()
  mockConfig.tags.defaultExcluded = ['useless']
})

describe('tag normalization', () => {
  it('folds case and surrounding space so one idea is one tag', () => {
    expect(normalizeTag('  Useless ')).toBe('useless')
    expect(normalizeTag('USELESS')).toBe('useless')
  })

  it('collapses internal whitespace, so a multi-word tag survives sloppy spacing', () => {
    expect(normalizeTag('needs   follow up')).toBe('needs follow up')
  })

  it('accepts tags nothing has ever seen before', () => {
    // THE POINT OF THE WHOLE FEATURE: the vocabulary is open. An agent outside
    // this codebase must be able to invent a word without registering it, so
    // this must never throw and must never come back empty for a real string.
    expect(normalizeTags(['xyzzy-never-used-before', 'ephemeral/thing:2'])).toEqual([
      'xyzzy-never-used-before',
      'ephemeral/thing:2',
    ])
  })

  it('drops blanks and duplicates rather than writing junk rows', () => {
    expect(normalizeTags(['a', '', '   ', 'A', 'b'])).toEqual(['a', 'b'])
  })
})

describe('the default-excluded set', () => {
  it('hides "useless" when the caller says nothing', () => {
    expect(resolveExcludedTags([], [])).toEqual(['useless'])
  })

  it('steps aside when the caller asks for that tag by name', () => {
    // Without this the default set is a one-way door: sessions marked useless
    // could never be reviewed, listed, or un-marked, which is exactly what
    // makes the current hard soft-delete a problem.
    expect(resolveExcludedTags(['useless'], [])).toEqual([])
  })

  it('still honours an explicit exclusion of a tag the caller also included', () => {
    // Naming a tag on both sides is a contradiction; refusing to show it is
    // the safe reading, and it stays distinct from the default-set override.
    expect(resolveExcludedTags(['useless'], ['useless'])).toEqual(['useless'])
  })

  it('adds the caller exclusions on top of the default set', () => {
    expect(resolveExcludedTags([], ['Noise'])).toEqual(['useless', 'noise'])
  })

  it('is configurable without a code change', () => {
    mockConfig.tags.defaultExcluded = ['useless', 'Spam']
    expect(resolveExcludedTags([], [])).toEqual(['useless', 'spam'])
  })

  it('can be emptied entirely, hiding nothing', () => {
    mockConfig.tags.defaultExcluded = []
    expect(resolveExcludedTags([], [])).toEqual([])
  })
})

describe('the default-excluded set comes from the environment', () => {
  // Separate from the tests above, which mock config away: this one proves the
  // env var actually reaches config, so "configurable" is a fact about
  // deployment and not just about a mock.
  const loadRealConfig = async (value: string | undefined) => {
    const previous = process.env.MINDMELD_DEFAULT_EXCLUDED_TAGS
    if (value === undefined) delete process.env.MINDMELD_DEFAULT_EXCLUDED_TAGS
    else process.env.MINDMELD_DEFAULT_EXCLUDED_TAGS = value
    vi.resetModules()
    const actual = (await vi.importActual('../config.js')) as { config: { tags: { defaultExcluded: string[] } } }
    if (previous === undefined) delete process.env.MINDMELD_DEFAULT_EXCLUDED_TAGS
    else process.env.MINDMELD_DEFAULT_EXCLUDED_TAGS = previous
    return actual.config.tags.defaultExcluded
  }

  it('defaults to hiding "useless"', async () => {
    expect(await loadRealConfig(undefined)).toEqual(['useless'])
  })

  it('takes a comma-separated list', async () => {
    expect(await loadRealConfig('useless, spam')).toEqual(['useless', 'spam'])
  })

  it('reads an explicitly empty value as "hide nothing"', async () => {
    // Not "fall back to the default" — otherwise the setting could be changed
    // but never turned off.
    expect(await loadRealConfig('')).toEqual([])
  })
})

describe('passesTagFilter', () => {
  it('lets everything through when nothing was asked for', () => {
    expect(passesTagFilter(emptyTagFilter(), 1, 2)).toBe(true)
  })

  it('distinguishes "no include filter" from "an include filter that matched nothing"', () => {
    const none = { ...emptyTagFilter(), includedSessions: new Set<number>() }
    // A requested tag nobody has used must return nothing, not everything.
    expect(passesTagFilter(none, 1)).toBe(false)
    expect(passesTagFilter(emptyTagFilter(), 1)).toBe(true)
  })

  it('hides a session tagged for exclusion', () => {
    const filter = { ...emptyTagFilter(), excludedSessions: new Set([1]) }
    expect(passesTagFilter(filter, 1)).toBe(false)
    expect(passesTagFilter(filter, 2)).toBe(true)
  })

  it('lets a message-level exclusion hide the message WITHOUT hiding its session', () => {
    // The asymmetry that matters: one bad message must not delete an entire
    // useful conversation from search.
    const filter = { ...emptyTagFilter(), excludedMessages: new Set([77]) }
    expect(passesTagFilter(filter, 1, 77)).toBe(false)
    expect(passesTagFilter(filter, 1, 78)).toBe(true)
    expect(passesTagFilter(filter, 1)).toBe(true)
  })
})

describe('resolveTagFilter', () => {
  it('folds a message-level tag up to its session, so message tags are findable', async () => {
    // Include is generous on purpose: the searcher does not know which
    // granularity the tagging agent chose, so both must match.
    query.mockResolvedValueOnce({ rows: [{ session_id: 4 }], rowCount: 1 } as never)
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const filter = await resolveTagFilter({ tags: ['keeper'] })
    expect(filter.includedSessions).toEqual(new Set([4]))
    expect(String(query.mock.calls[0][0])).toContain('COALESCE(t.session_id, m.session_id)')
  })

  it('splits exclusions by the granularity they were applied at', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { session_id: 3, message_id: null },
        { session_id: null, message_id: '88' },
      ],
      rowCount: 2,
    } as never)
    const filter = await resolveTagFilter({})
    expect(filter.excludedSessions).toEqual(new Set([3]))
    // message_id is BIGINT, which node-postgres returns as a string; a Set of
    // strings would never match the numeric ids the search arms carry.
    expect(filter.excludedMessages).toEqual(new Set([88]))
  })

  it('applies the default exclusion even when no tag params were passed', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const filter = await resolveTagFilter({})
    expect(filter.excludeTags).toEqual(['useless'])
    expect(filter.includedSessions).toBeNull()
  })

  it('asks the database nothing when there is nothing to filter by', async () => {
    mockConfig.tags.defaultExcluded = []
    await resolveTagFilter({})
    expect(query).not.toHaveBeenCalled()
  })
})

describe('writes', () => {
  it('normalizes before storing, so the stored tag matches what search looks for', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never) // target exists
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // insert
    const applied = await applyTags({ sessionId: 5 }, ['  Useless '])
    expect(applied).toEqual(['useless'])
    expect(query.mock.calls[1][1] as unknown[]).toEqual([5, ['useless'], null, null])
  })

  it('re-tagging is a no-op rather than a duplicate or an error', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never)
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await applyTags({ sessionId: 5 }, ['useless'])
    expect(String(query.mock.calls[1][0])).toContain('ON CONFLICT')
    expect(String(query.mock.calls[1][0])).toContain('DO NOTHING')
  })

  it('reports a missing target as a plain sentence, not a foreign-key violation', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await expect(applyTags({ sessionId: 999 }, ['x'])).rejects.toThrow('No such session 999')
  })

  it('does not touch the database when given no usable tag', async () => {
    expect(await applyTags({ sessionId: 5 }, ['  '])).toEqual([])
    expect(await removeTags({ sessionId: 5 }, [])).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it('reports which tags were actually removed', async () => {
    query.mockResolvedValueOnce({ rows: [{ tag: 'useless' }], rowCount: 1 } as never)
    // Asked for two, only one was there — the caller learns the difference
    // instead of the no-op being an error.
    expect(await removeTags({ sessionId: 5 }, ['useless', 'never-applied'])).toEqual(['useless'])
  })
})

describe('tagging a message rather than a session', () => {
  // Every write path below forks on which target it was given: a different
  // existence check, a different column, a different id, and a different noun
  // in the error. Session-only tests leave the whole message half of that fork
  // unexercised, which matters because message-level tagging is the granular
  // half of the feature -- it is what lets an agent call one message noise
  // without condemning the conversation around it.
  it('checks the target exists against messages, not sessions', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never)
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await applyTags({ messageId: 42 }, ['noisy'])
    expect(String(query.mock.calls[0][0])).toContain('FROM messages')
    expect(query.mock.calls[0][1] as unknown[]).toEqual([42])
  })

  it('stores the tag against message_id, not session_id', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never)
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await applyTags({ messageId: 42 }, ['  Noisy '])
    // Normalization is not session-specific, and proving it here stops the
    // message path from quietly storing "Noisy" that search never matches.
    expect(String(query.mock.calls[1][0])).toContain('INSERT INTO tags (message_id')
    expect(query.mock.calls[1][1] as unknown[]).toEqual([42, ['noisy'], null, null])
  })

  it('names the message, not a session, when the id does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await expect(applyTags({ messageId: 999 }, ['x'])).rejects.toThrow('No such message 999')
  })

  it('deletes by message_id and reports what went', async () => {
    query.mockResolvedValueOnce({ rows: [{ tag: 'noisy' }], rowCount: 1 } as never)
    expect(await removeTags({ messageId: 42 }, ['Noisy'])).toEqual(['noisy'])
    expect(String(query.mock.calls[0][0])).toContain('DELETE FROM tags WHERE message_id')
    expect(query.mock.calls[0][1] as unknown[]).toEqual([42, ['noisy']])
  })

  it('records who tagged it and why when it is told', async () => {
    // The provenance columns are the difference between "this session is
    // useless" and "some agent decided this was useless, on this basis" --
    // without them a bad tag is unattributable and cannot be reviewed.
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never)
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await applyTags({ sessionId: 5 }, ['useless'], { createdBy: 'some-agent', note: 'monitoring run' })
    expect(query.mock.calls[1][1] as unknown[]).toEqual([5, ['useless'], 'some-agent', 'monitoring run'])
  })
})

describe('reading tags back', () => {
  it('reads a session\'s tags in a stable order', async () => {
    // Ordered in SQL rather than at the call site: the confirmation text and
    // the search display both render this list, and two different orders for
    // the same state reads as a change that did not happen.
    query.mockResolvedValueOnce({ rows: [{ tag: 'keeper' }, { tag: 'useless' }], rowCount: 2 } as never)
    expect(await getTags({ sessionId: 5 })).toEqual(['keeper', 'useless'])
    expect(String(query.mock.calls[0][0])).toContain('WHERE session_id = $1')
    expect(String(query.mock.calls[0][0])).toContain('ORDER BY tag')
    expect(query.mock.calls[0][1] as unknown[]).toEqual([5])
  })

  it('reads a message\'s tags from the message column', async () => {
    query.mockResolvedValueOnce({ rows: [{ tag: 'noisy' }], rowCount: 1 } as never)
    expect(await getTags({ messageId: 42 })).toEqual(['noisy'])
    expect(String(query.mock.calls[0][0])).toContain('WHERE message_id = $1')
    expect(query.mock.calls[0][1] as unknown[]).toEqual([42])
  })

  it('comes back empty for an untagged target instead of throwing', async () => {
    // getTags runs immediately after every write to build the confirmation, so
    // "nothing is tagged" is the ordinary case on a first removal, not an edge.
    expect(await getTags({ sessionId: 5 })).toEqual([])
  })
})

describe('session tags for a page of results', () => {
  it('groups every tag under the session that carries it', async () => {
    // A session with two tags is the only thing that exercises the append
    // path; with one tag each, the grouping loop only ever creates lists.
    query.mockResolvedValueOnce({
      rows: [
        { session_id: 7, tag: 'keeper' },
        { session_id: 7, tag: 'useless' },
        { session_id: 9, tag: 'keeper' },
      ],
      rowCount: 3,
    } as never)
    const bySession = await getSessionTags([7, 9])
    expect(bySession.get(7)).toEqual(['keeper', 'useless'])
    expect(bySession.get(9)).toEqual(['keeper'])
  })

  it('leaves an untagged session absent rather than present-and-empty', async () => {
    // Search renders this map per hit; an empty array would print an empty tag
    // strip on every untagged result.
    query.mockResolvedValueOnce({ rows: [{ session_id: 7, tag: 'keeper' }], rowCount: 1 } as never)
    const bySession = await getSessionTags([7, 8])
    expect(bySession.has(8)).toBe(false)
  })

  it('asks the database nothing for an empty page of results', async () => {
    expect(await getSessionTags([])).toEqual(new Map())
    expect(query).not.toHaveBeenCalled()
  })
})

describe('what the agent is told after a write', () => {
  it('reports what was applied and the state that resulted', () => {
    expect(formatTagWrite('Tagged', { sessionId: 5 }, ['useless'], ['keeper', 'useless'])).toBe(
      'Tagged session 5: useless\nTags now: keeper, useless'
    )
  })

  it('says plainly that nothing changed rather than claiming a write', () => {
    // Idempotence is the feature, so a no-op has to READ as a no-op. Echoing
    // "Untagged message 42: " with an empty list would tell an agent it had
    // removed something it never removed.
    expect(formatTagWrite('Untagged', { messageId: 42 }, [], ['keeper'])).toBe(
      'No change to message 42. Tags now: keeper'
    )
  })

  it('says "(none)" rather than trailing off when the last tag is gone', () => {
    expect(formatTagWrite('Untagged', { sessionId: 5 }, ['useless'], [])).toBe(
      'Untagged session 5: useless\nTags now: (none)'
    )
  })

  it('says "(none)" on a no-op against a target that was never tagged', () => {
    expect(formatTagWrite('Tagged', { messageId: 42 }, [], [])).toBe(
      'No change to message 42. Tags now: (none)'
    )
  })
})
