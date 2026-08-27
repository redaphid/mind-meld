import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock, queriesMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
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

const { saveNote, formatSavedNote } = await import('./notes.js')

beforeEach(() => {
  queryMock.mockReset()
  for (const fn of Object.values(queriesMock)) fn.mockReset()

  queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
  queriesMock.getOrCreateSource.mockResolvedValue({ id: 9, name: 'claude-note', data_class: 'notes' })
  queriesMock.upsertProject.mockResolvedValue(3)
  queriesMock.upsertSession.mockResolvedValue(42)
  queriesMock.insertMessage.mockResolvedValue(101)
  queriesMock.updateSessionStats.mockResolvedValue(undefined)
  queriesMock.updateSessionContentChars.mockResolvedValue(undefined)
})

describe('saveNote', () => {
  it('rejects empty or whitespace-only text without touching the db', async () => {
    await expect(saveNote({ text: '   ' })).rejects.toThrow('Note text must not be empty.')
    expect(queriesMock.getOrCreateSource).not.toHaveBeenCalled()
  })

  it('classifies the source as dataClass notes, matching the Vikunja/agent-ops convention', async () => {
    await saveNote({ text: 'remember to feed the cat' })
    expect(queriesMock.getOrCreateSource).toHaveBeenCalledWith('claude-note', 'Saved Notes', 'notes')
  })

  it('stores the note under a shared Notes project, not one project per note', async () => {
    await saveNote({ text: 'remember to feed the cat' })
    expect(queriesMock.upsertProject).toHaveBeenCalledWith(9, 'notes', null, 'Notes')
  })

  it('creates one session per note with a fresh external id each call', async () => {
    await saveNote({ text: 'first note' })
    await saveNote({ text: 'second note' })
    const ids = queriesMock.upsertSession.mock.calls.map((c) => c[0].externalId)
    expect(ids[0]).not.toBe(ids[1])
    expect(ids[0]).toMatch(/^note-/)
  })

  it('uses the given title verbatim when provided', async () => {
    await saveNote({ text: 'body text here', title: '  Grocery list  ' })
    expect(queriesMock.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Grocery list' })
    )
  })

  it('derives a title from the first non-blank line when none is given', async () => {
    await saveNote({ text: '\n\nBuy milk\nand eggs' })
    expect(queriesMock.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Buy milk' })
    )
  })

  it('shortens an overlong derived title without touching the stored message text', async () => {
    const longLine = 'x'.repeat(200)
    await saveNote({ text: longLine })
    const { title } = queriesMock.upsertSession.mock.calls[0][0]
    expect(title.length).toBeLessThanOrEqual(80)
    expect(title.endsWith('...')).toBe(true)
    // The full, untruncated text still reaches the message row.
    expect(queriesMock.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contentText: longLine })
    )
  })

  it('inserts the message under role user with the trimmed full text', async () => {
    await saveNote({ text: '  needs trimming  ' })
    expect(queriesMock.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 42, role: 'user', contentText: 'needs trimming', sequenceNum: 0 })
    )
  })

  it('sets the session summary directly to the note text so it is searchable without waiting on the LLM summarizer', async () => {
    await saveNote({ text: 'a durable fact worth keeping' })
    expect(queryMock).toHaveBeenCalledWith(
      'UPDATE sessions SET summary = $1 WHERE id = $2',
      ['a durable fact worth keeping', 42]
    )
  })

  it('updates session stats and content chars after inserting', async () => {
    await saveNote({ text: 'anything' })
    expect(queriesMock.updateSessionStats).toHaveBeenCalledWith(42)
    expect(queriesMock.updateSessionContentChars).toHaveBeenCalledWith(42)
  })

  it('returns the session id, resolved title, and the source data class', async () => {
    const result = await saveNote({ text: 'anything', title: 'My Title' })
    expect(result).toEqual({ sessionId: 42, title: 'My Title', dataClass: 'notes' })
  })
})

describe('formatSavedNote', () => {
  it('tells the caller the dataClass filter needed to find the note again', () => {
    const out = formatSavedNote({ sessionId: 7, title: 'Buy milk', dataClass: 'notes' })
    expect(out).toContain('session 7')
    expect(out).toContain('"Buy milk"')
    expect(out).toContain('dataClass: ["notes"]')
  })
})
