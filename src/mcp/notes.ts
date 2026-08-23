import { randomUUID } from 'node:crypto'
import { query, queries } from '../db/postgres.js'

// The explicit "remember this" tool. Distinct from the sync pipeline (which
// pulls whole conversations off disk) and from reportUselessSession (which
// only ever deletes) - this is the one write path a client with no transcript
// of its own can use to put something into mindmeld at all. It exists because
// Claude web/mobile has no session file for mindmeld to sync: without this,
// nothing said there ever reaches the index.
//
// A note is stored as its own one-message session, under a dedicated source
// classified dataClass "notes" - the same convention already used by the
// Vikunja and agent-ops sources (both dataClass "notes"), so it lands
// alongside them rather than inventing a fourth vocabulary word.

export type SaveNoteParams = {
  text: string
  title?: string
}

export type SavedNote = {
  sessionId: number
  title: string
  dataClass: string
}

const NOTE_SOURCE = 'claude-note'
const NOTE_SOURCE_DISPLAY = 'Saved Notes'
const NOTE_DATA_CLASS = 'notes'
const NOTES_PROJECT_EXTERNAL_ID = 'notes'
const NOTES_PROJECT_NAME = 'Notes'

const MAX_TITLE_LEN = 80

// A display label only - the full text is stored untouched in the message
// and in the session summary below, so shortening this is not the kind of
// truncation the no-truncation policy (CLAUDE.md) is about: that policy
// covers content returned to API consumers, not a derived label.
const deriveTitle = (text: string): string => {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? text.trim()
  return firstLine.length > MAX_TITLE_LEN ? `${firstLine.slice(0, MAX_TITLE_LEN - 3)}...` : firstLine
}

export const saveNote = async ({ text, title }: SaveNoteParams): Promise<SavedNote> => {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Note text must not be empty.')

  const resolvedTitle = title?.trim() || deriveTitle(trimmed)

  const source = await queries.getOrCreateSource(NOTE_SOURCE, NOTE_SOURCE_DISPLAY, NOTE_DATA_CLASS)
  const projectId = await queries.upsertProject(source.id, NOTES_PROJECT_EXTERNAL_ID, null, NOTES_PROJECT_NAME)

  // A fresh id per save (never reused), so upsertSession always inserts a new
  // row instead of colliding two unrelated notes onto one session.
  const externalId = `note-${randomUUID()}`
  const now = new Date()

  const sessionId = await queries.upsertSession({
    projectId,
    externalId,
    title: resolvedTitle,
    startedAt: now,
    endedAt: now,
  })

  await queries.insertMessage({
    sessionId,
    externalId: `${externalId}-msg`,
    role: 'user',
    contentText: trimmed,
    timestamp: now,
    sequenceNum: 0,
  })

  await queries.updateSessionStats(sessionId)
  await queries.updateSessionContentChars(sessionId)

  // Notes are already terse, so the note IS its own summary - set it directly
  // rather than leaving the session to wait in the async LLM summarization
  // queue. Session-tier search excludes summary IS NULL by default (search.ts),
  // so without this a freshly saved note would be unreachable until a
  // background worker eventually got to a one-message session; full-text
  // search over the message itself works immediately either way (plain GIN
  // index, no async step), but the session-level hit would not.
  await query('UPDATE sessions SET summary = $1 WHERE id = $2', [trimmed, sessionId])

  return { sessionId, title: resolvedTitle, dataClass: source.data_class }
}

export const formatSavedNote = (note: SavedNote): string =>
  `Note saved (session ${note.sessionId}): "${note.title}"\n\n` +
  `Stored under dataClass "${note.dataClass}". search() defaults to dataClass ["coding"], ` +
  `so it will NOT show up in a plain search - pass dataClass: ["${note.dataClass}"] (or ["*"]) ` +
  `to find it again, e.g. search({ query: "...", dataClass: ["${note.dataClass}"] }).`
