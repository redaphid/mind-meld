import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock, queriesMock, applyTagsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  applyTagsMock: vi.fn(),
  queriesMock: {
    getOrCreateSource: vi.fn(),
    upsertProject: vi.fn(),
    upsertSession: vi.fn(),
    insertMessage: vi.fn(),
    updateSessionStats: vi.fn(),
    updateSessionContentChars: vi.fn(),
  },
}))

vi.mock('../db/postgres.js', () => ({
  query: queryMock,
  queries: queriesMock,
}))

vi.mock('./tags.js', () => ({
  applyTags: (...args: unknown[]) => applyTagsMock(...(args as [])),
}))

const { writeNote, formatWrittenNote, NOTE_TAG } = await import('./notes.js')

beforeEach(() => {
  queryMock.mockReset()
  applyTagsMock.mockReset()
  for (const fn of Object.values(queriesMock)) fn.mockReset()

  queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
  applyTagsMock.mockResolvedValue(['note'])
  queriesMock.getOrCreateSource.mockResolvedValue({ id: 9, name: 'claude-note', data_class: 'notes' })
  queriesMock.upsertProject.mockResolvedValue(3)
  queriesMock.upsertSession.mockResolvedValue(42)
  queriesMock.insertMessage.mockResolvedValue(101)
  queriesMock.updateSessionStats.mockResolvedValue(undefined)
  queriesMock.updateSessionContentChars.mockResolvedValue(undefined)
})

describe('writeNote', () => {
  it('rejects empty or whitespace-only text without touching the db', async () => {
    await expect(writeNote({ text: '   ' })).rejects.toThrow('Note text must not be empty.')
    expect(queriesMock.getOrCreateSource).not.toHaveBeenCalled()
  })

  it('classifies the source as dataClass notes, matching the Vikunja/agent-ops convention', async () => {
    await writeNote({ text: 'remember to feed the cat' })
    expect(queriesMock.getOrCreateSource).toHaveBeenCalledWith('claude-note', 'Saved Notes', 'notes')
  })

  it('stores the note under a shared Notes project, not one project per note', async () => {
    await writeNote({ text: 'remember to feed the cat' })
    expect(queriesMock.upsertProject).toHaveBeenCalledWith(9, 'notes', null, 'Notes')
  })

  it('creates one session per note with a fresh external id each call', async () => {
    await writeNote({ text: 'first note' })
    await writeNote({ text: 'second note' })
    const ids = queriesMock.upsertSession.mock.calls.map((c) => c[0].externalId)
    expect(ids[0]).not.toBe(ids[1])
    expect(ids[0]).toMatch(/^note-/)
  })

  it('uses the given title verbatim when provided', async () => {
    await writeNote({ text: 'body text here', title: '  Grocery list  ' })
    expect(queriesMock.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Grocery list' })
    )
  })

  it('derives a title from the first non-blank line when none is given', async () => {
    await writeNote({ text: '\n\nBuy milk\nand eggs' })
    expect(queriesMock.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Buy milk' })
    )
  })

  it('shortens an overlong derived title without touching the stored message text', async () => {
    const longLine = 'x'.repeat(200)
    await writeNote({ text: longLine })
    const { title } = queriesMock.upsertSession.mock.calls[0][0]
    expect(title.length).toBeLessThanOrEqual(80)
    expect(title.endsWith('...')).toBe(true)
    // The full, untruncated text still reaches the message row.
    expect(queriesMock.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contentText: longLine })
    )
  })

  it('inserts the message under role user with the trimmed full text', async () => {
    await writeNote({ text: '  needs trimming  ' })
    expect(queriesMock.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 42, role: 'user', contentText: 'needs trimming', sequenceNum: 0 })
    )
  })

  it('sets the session summary directly to the note text so it is searchable without waiting on the LLM summarizer', async () => {
    await writeNote({ text: 'a durable fact worth keeping' })
    expect(queryMock).toHaveBeenCalledWith(
      'UPDATE sessions SET summary = $1 WHERE id = $2',
      ['a durable fact worth keeping', 42]
    )
  })

  it('updates session stats and content chars after inserting', async () => {
    await writeNote({ text: 'anything' })
    expect(queriesMock.updateSessionStats).toHaveBeenCalledWith(42)
    expect(queriesMock.updateSessionContentChars).toHaveBeenCalledWith(42)
  })

  // The automatic tag is the thing that separates a written note from synced
  // material, so it has to hold when the caller passes nothing at all.
  it('always tags the note "note", even when no tags are given', async () => {
    await writeNote({ text: 'anything' })
    expect(applyTagsMock).toHaveBeenCalledWith({ sessionId: 42 }, ['note'], { createdBy: 'writeNote' })
  })

  it('keeps the automatic tag first and appends the caller-chosen tags after it', async () => {
    await writeNote({ text: 'anything', tags: ['decision', 'mindmeld'] })
    expect(applyTagsMock).toHaveBeenCalledWith(
      { sessionId: 42 },
      ['note', 'decision', 'mindmeld'],
      { createdBy: 'writeNote' }
    )
  })

  // Tagging goes through task 327's applyTags rather than a note-specific
  // insert, so notes are ordinary rows in the shared `tags` table and every
  // tag-aware query already sees them. A regression here would mean a second
  // tagging mechanism had crept in.
  it('tags the session through the shared tag store, not a mechanism of its own', async () => {
    await writeNote({ text: 'anything' })
    const [target] = applyTagsMock.mock.calls[0]
    expect(target).toEqual({ sessionId: 42 })
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO tags'),
      expect.anything()
    )
  })

  it('tags only after the session exists, since a tag references it', async () => {
    const order: string[] = []
    queriesMock.upsertSession.mockImplementation(async () => {
      order.push('session')
      return 42
    })
    applyTagsMock.mockImplementation(async () => {
      order.push('tags')
      return ['note']
    })
    await writeNote({ text: 'anything' })
    expect(order).toEqual(['session', 'tags'])
  })

  // Deduplication is applyTags' job (it normalizes), so writeNote must report
  // what actually landed rather than what it asked for.
  it('returns the tags the tag store actually applied, not the requested list', async () => {
    applyTagsMock.mockResolvedValue(['note', 'decision'])
    const result = await writeNote({ text: 'anything', tags: ['Note', 'decision'] })
    expect(result.tags).toEqual(['note', 'decision'])
  })

  it('surfaces a tagging failure instead of silently returning an untagged note', async () => {
    applyTagsMock.mockRejectedValue(new Error('tag store down'))
    await expect(writeNote({ text: 'anything' })).rejects.toThrow('tag store down')
  })

  it('returns the session id, resolved title, the source data class, and the tags', async () => {
    const result = await writeNote({ text: 'anything', title: 'My Title' })
    expect(result).toEqual({ sessionId: 42, title: 'My Title', dataClass: 'notes', tags: ['note'] })
  })

  it('exports the automatic tag so callers and tests agree on the word', () => {
    expect(NOTE_TAG).toBe('note')
  })
})

describe('formatWrittenNote', () => {
  it('tells the caller the dataClass filter needed to find the note again', () => {
    const out = formatWrittenNote({ sessionId: 7, title: 'Buy milk', dataClass: 'notes', tags: ['note'] })
    expect(out).toContain('session 7')
    expect(out).toContain('"Buy milk"')
    expect(out).toContain('dataClass: ["notes"]')
  })

  it('reports the tags that were applied and how to search by them', () => {
    const out = formatWrittenNote({
      sessionId: 7,
      title: 'Buy milk',
      dataClass: 'notes',
      tags: ['note', 'errand'],
    })
    expect(out).toContain('note, errand')
    expect(out).toContain('tags: ["note"]')
  })
})
