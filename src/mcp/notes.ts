import { randomUUID } from 'node:crypto'
import { query, queries } from '../db/postgres.js'
import { applyTags } from './tags.js'

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
//
// NAMING: the exported function is `writeNote`, matching the name in the task
// spec and the framing there ("mindmeld is read-only to agents; this is the
// write path").
//
// This branch originally argued for no `saveNote` alias on the grounds that
// the name had never shipped. That reasoning expired: v1.22.0 released #131,
// so `saveNote` IS on the live tool surface and callers can already be using
// it. The old name is kept briefly, but only where it is actually observable:
// as an MCP tool named `saveNote` in tools.ts, which delegates to writeNote().
// There is deliberately no alias EXPORT here - nothing imports one, and two
// exported bindings for one function is duplicate surface with no caller.
// The removal condition lives with the registration in tools.ts.

export type WriteNoteParams = {
  text: string
  title?: string
  tags?: readonly string[]
}

export type WrittenNote = {
  sessionId: number
  title: string
  dataClass: string
  tags: string[]
}

const NOTE_SOURCE = 'claude-note'
const NOTE_SOURCE_DISPLAY = 'Saved Notes'
const NOTE_DATA_CLASS = 'notes'
const NOTES_PROJECT_EXTERNAL_ID = 'notes'
const NOTES_PROJECT_NAME = 'Notes'

// The tag every note carries, always, whatever else the caller asks for.
//
// dataClass "notes" is NOT a substitute for it: that class is shared with the
// Vikunja and agent-ops sync sources, so it answers "is this non-coding
// material" rather than "did an agent deliberately write this down". The tag
// is the thing that separates a note from synced material, which is the whole
// point of applying it automatically.
//
// It is an ordinary row in task 327's `tags` table, written through the same
// applyTags() that addTag uses - not a column, not a flag, and not a second
// tagging mechanism. tags.ts names this integration explicitly. The practical
// consequence is that search({ tags: ["note"] }) already finds every note with
// no code in the search layer that knows notes exist.
export const NOTE_TAG = 'note'

const MAX_TITLE_LEN = 80

// A display label only - the full text is stored untouched in the message
// and in the session summary below, so shortening this is not the kind of
// truncation the no-truncation policy (CLAUDE.md) is about: that policy
// covers content returned to API consumers, not a derived label.
const deriveTitle = (text: string): string => {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? text.trim()
  return firstLine.length > MAX_TITLE_LEN ? `${firstLine.slice(0, MAX_TITLE_LEN - 3)}...` : firstLine
}

export const writeNote = async ({ text, title, tags }: WriteNoteParams): Promise<WrittenNote> => {
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

  // The automatic tag leads, so it survives even if the caller passes nothing.
  // applyTags normalizes and de-duplicates, so a caller who also passes "Note"
  // or " note " gets one tag rather than three - which is why the automatic tag
  // does not need to be filtered out of the caller's list here.
  //
  // Tagged AFTER the session row exists because a tag references it. If this
  // throws, the note itself is already written and searchable and the caller
  // sees the failure rather than a silent claim that it was tagged; the
  // alternative - swallowing the error - would make "always tagged" a promise
  // the code does not keep.
  const applied = await applyTags({ sessionId }, [NOTE_TAG, ...(tags ?? [])], { createdBy: 'writeNote' })

  return { sessionId, title: resolvedTitle, dataClass: source.data_class, tags: applied }
}

export const formatWrittenNote = (note: WrittenNote): string =>
  `Note saved (session ${note.sessionId}): "${note.title}"\n` +
  `Tags: ${note.tags.join(', ')}\n\n` +
  `Stored under dataClass "${note.dataClass}". search() defaults to dataClass ["coding"], ` +
  `so it will NOT show up in a plain search - pass dataClass: ["${note.dataClass}"] (or ["*"]) ` +
  `to find it again, e.g. search({ query: "...", dataClass: ["${note.dataClass}"] }).\n` +
  `Every note carries the "${NOTE_TAG}" tag, so search({ tags: ["${NOTE_TAG}"] }) returns ` +
  `written notes only, separating them from material that arrived through sync.`
