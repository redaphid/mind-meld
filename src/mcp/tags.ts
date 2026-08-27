import { query } from '../db/postgres.js'
import { config } from '../config.js'

// Agent-managed tags. THE VOCABULARY IS OPEN: any string is a valid tag, and
// there is no registration step, no allow-list, and no "unknown tag" error.
//
// This is a deliberate asymmetry with `dataClass`, which lives one module over
// in search.ts and DOES reject unrecognised values via assertKnownDataClasses.
// That check is right for data classes -- there are five of them, they are
// assigned by ingestion, and a typo silently returns nothing. It is wrong for
// tags, because other agents use mindmeld from outside this codebase and will
// invent words we have not thought of; a validation step here would turn every
// one of those into an error at the moment the agent was trying to be useful.
//
// So the only rule applied to a tag is NORMALIZATION, below. Normalizing is
// not validating: nothing is refused for being unrecognised, it is only
// spelled consistently, which is what lets filtering and the default-excluded
// set match at all.

export type TagTarget = { sessionId: number; messageId?: undefined } | { sessionId?: undefined; messageId: number }

// Trim, lowercase, and collapse internal runs of whitespace. Lowercasing
// follows the rule search.ts already states for dataClass: "the vocabulary is
// lowercase, and a miscased value should match rather than silently return
// nothing". An agent that writes "Useless" and an agent that writes "useless"
// mean the same thing and must land on the same tag, or the default-excluded
// set is trivially defeated by capitalisation.
export const normalizeTag = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, ' ')

// Normalize a list, drop blanks, and de-duplicate while keeping first-seen
// order. An empty result is a real possibility (someone passed [""]), and the
// callers below treat it as "no tags" rather than erroring -- the error case
// worth reporting is "you asked to tag something and named no tag at all",
// which the tools check explicitly.
export const normalizeTags = (raw: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const tag = normalizeTag(item)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

const describeTarget = (target: TagTarget) =>
  target.sessionId != null ? `session ${target.sessionId}` : `message ${target.messageId}`

// A missing target would otherwise surface as a raw foreign-key violation,
// which reads to an LLM as "mindmeld is broken" rather than "that id does not
// exist". Cheap, indexed, and worth the round trip for an honest error.
const assertTargetExists = async (target: TagTarget): Promise<void> => {
  const { rowCount } =
    target.sessionId != null
      ? await query('SELECT 1 FROM sessions WHERE id = $1', [target.sessionId])
      : await query('SELECT 1 FROM messages WHERE id = $1', [target.messageId])
  if (rowCount === 0) throw new Error(`No such ${describeTarget(target)}.`)
}

export type TagWriteOptions = { createdBy?: string; note?: string }

// Apply tags to one target. Idempotent: re-tagging is a no-op rather than a
// duplicate row or an error, so an agent can tag freely without first checking
// what is already there. Returns the normalized tags now on the target's
// request (not only the newly-inserted ones) -- the caller asked for a state,
// and that state is what it gets back.
//
// THIS IS THE FUNCTION saveNote() SHOULD CALL (task 329): once a note's
// session row exists, `await applyTags({ sessionId }, tags)` is the whole
// integration. Nothing about tagging is specific to how the session was
// created, so notes need no tagging mechanism of their own.
export const applyTags = async (
  target: TagTarget,
  tags: readonly string[],
  options: TagWriteOptions = {}
): Promise<string[]> => {
  const normalized = normalizeTags(tags)
  if (normalized.length === 0) return []
  await assertTargetExists(target)

  const column = target.sessionId != null ? 'session_id' : 'message_id'
  const targetId = target.sessionId ?? target.messageId

  // unnest() so any number of tags is one statement and one round trip.
  await query(
    `INSERT INTO tags (${column}, tag, created_by, note)
     SELECT $1, t, $3, $4 FROM unnest($2::text[]) AS t
     ON CONFLICT (${column}, tag) WHERE ${column} IS NOT NULL DO NOTHING`,
    [targetId, normalized, options.createdBy ?? null, options.note ?? null]
  )
  return normalized
}

// Remove tags from one target. Returns the tags that were actually removed,
// which may be fewer than asked for; the difference is how a caller learns it
// removed something that was never there, without that being an error.
export const removeTags = async (target: TagTarget, tags: readonly string[]): Promise<string[]> => {
  const normalized = normalizeTags(tags)
  if (normalized.length === 0) return []

  const column = target.sessionId != null ? 'session_id' : 'message_id'
  const targetId = target.sessionId ?? target.messageId
  const result = await query<{ tag: string }>(
    `DELETE FROM tags WHERE ${column} = $1 AND tag = ANY($2::text[]) RETURNING tag`,
    [targetId, normalized]
  )
  return result.rows.map((r) => r.tag)
}

export const getTags = async (target: TagTarget): Promise<string[]> => {
  const column = target.sessionId != null ? 'session_id' : 'message_id'
  const targetId = target.sessionId ?? target.messageId
  const result = await query<{ tag: string }>(
    `SELECT tag FROM tags WHERE ${column} = $1 ORDER BY tag`,
    [targetId]
  )
  return result.rows.map((r) => r.tag)
}

// Session-level tags for a batch of sessions, for display alongside results.
// Message-level tags are deliberately not folded in here: they belong to a
// message, and showing them on the session would misreport which thing an
// agent actually judged.
export const getSessionTags = async (sessionIds: readonly number[]): Promise<Map<number, string[]>> => {
  const bySession = new Map<number, string[]>()
  if (sessionIds.length === 0) return bySession
  const result = await query<{ session_id: number; tag: string }>(
    `SELECT session_id, tag FROM tags
     WHERE session_id = ANY($1::int[])
     ORDER BY session_id, tag`,
    [[...sessionIds]]
  )
  for (const row of result.rows) {
    const list = bySession.get(row.session_id)
    if (list) list.push(row.tag)
    else bySession.set(row.session_id, [row.tag])
  }
  return bySession
}

// The tags hidden from search unless asked for. Configurable by environment so
// a second hidden tag can be added without a code change; "useless" is the
// first member and the reason the set exists (task 326 folds the useless-session
// flag into this rather than keeping a parallel column).
export const defaultExcludedTags = (): string[] => normalizeTags(config.tags.defaultExcluded)

// Which exclusions actually apply to a search.
//
// An explicitly requested tag beats the DEFAULT exclusion of that same tag:
// asking for tags:["useless"] has to be able to find the useless sessions, or
// the default set becomes a one-way door and the hidden data is unreachable.
// An explicit excludeTags entry is NOT overridden the same way -- if a caller
// names a tag on both sides it is contradicting itself, and refusing to show
// the thing is the safe reading of a contradiction.
//
// includeNoise:true suspends the DEFAULT set entirely -- that is the debugging
// escape hatch reportUselessSession's description points at. It does NOT
// suspend an explicit excludeTags: the caller named those in this very call,
// and a general "show me the hidden stuff" flag has no business overriding a
// specific instruction given alongside it.
export const resolveExcludedTags = (
  includeTags: readonly string[],
  excludeTags: readonly string[],
  includeNoise = false
): string[] => {
  const requested = new Set(includeTags)
  const fromDefault = includeNoise ? [] : defaultExcludedTags().filter((tag) => !requested.has(tag))
  return normalizeTags([...fromDefault, ...excludeTags])
}

// Pre-resolved tag membership. Sets of ids rather than a SQL join, because the
// three semantic arms resolve their hits through Chroma and never touch the
// tag tables; one shared, pre-fetched filter keeps every arm -- semantic and
// full-text -- applying identical tag semantics instead of two mechanisms that
// can drift.
export type TagFilter = {
  // null means "no include filter was requested". An EMPTY set means one was
  // requested and nothing carries those tags -- which correctly matches
  // nothing. Conflating the two would silently ignore the filter.
  includedSessions: Set<number> | null
  excludedSessions: Set<number>
  excludedMessages: Set<number>
  includeTags: string[]
  excludeTags: string[]
}

export const emptyTagFilter = (): TagFilter => ({
  includedSessions: null,
  excludedSessions: new Set(),
  excludedMessages: new Set(),
  includeTags: [],
  excludeTags: [],
})

// Does this hit survive the tag filter? Pure, so the semantics are testable
// without a database.
//
// INCLUDE IS GENEROUS, EXCLUDE IS PRECISE, and the asymmetry is deliberate:
//
//  - Include matches a session if the session OR any of its messages carries
//    the tag (resolveTagFilter does that widening in SQL). Granularity is the
//    tagging agent's choice, so a searcher must not have to guess which one
//    was used -- otherwise message-level tags would be write-only.
//
//  - Exclude hides a session only when the SESSION itself carries the tag. A
//    message-level exclusion drops only that message's own hit. Widening this
//    the way include is widened would let one message tagged "useless" delete
//    an entire useful conversation from search, which is a far worse failure
//    than showing one hit too many.
export const passesTagFilter = (filter: TagFilter, sessionId: number, messageId?: number): boolean => {
  if (filter.includedSessions && !filter.includedSessions.has(sessionId)) return false
  if (filter.excludedSessions.has(sessionId)) return false
  if (messageId != null && filter.excludedMessages.has(messageId)) return false
  return true
}

export const resolveTagFilter = async (params: {
  tags?: string[]
  excludeTags?: string[]
  includeNoise?: boolean
}): Promise<TagFilter> => {
  const includeTags = normalizeTags(params.tags ?? [])
  const excludeTags = resolveExcludedTags(includeTags, params.excludeTags ?? [], params.includeNoise === true)

  const filter = emptyTagFilter()
  filter.includeTags = includeTags
  filter.excludeTags = excludeTags

  if (includeTags.length > 0) {
    // COALESCE folds a message-level tag up to its owning session, so one
    // statement covers both granularities.
    const result = await query<{ session_id: number }>(
      `SELECT DISTINCT COALESCE(t.session_id, m.session_id) AS session_id
       FROM tags t
       LEFT JOIN messages m ON m.id = t.message_id
       WHERE t.tag = ANY($1::text[])`,
      [includeTags]
    )
    filter.includedSessions = new Set(result.rows.map((r) => r.session_id).filter((id) => id != null))
  }

  if (excludeTags.length > 0) {
    const result = await query<{ session_id: number | null; message_id: string | null }>(
      `SELECT session_id, message_id FROM tags WHERE tag = ANY($1::text[])`,
      [excludeTags]
    )
    for (const row of result.rows) {
      // message_id is BIGINT; node-postgres hands back a string for those.
      if (row.session_id != null) filter.excludedSessions.add(Number(row.session_id))
      else if (row.message_id != null) filter.excludedMessages.add(Number(row.message_id))
    }
  }

  return filter
}

export const formatTagWrite = (
  verb: 'Tagged' | 'Untagged',
  target: TagTarget,
  applied: string[],
  current: string[]
): string => {
  const label = describeTarget(target)
  if (applied.length === 0)
    return `No change to ${label}. Tags now: ${current.length > 0 ? current.join(', ') : '(none)'}`
  return (
    `${verb} ${label}: ${applied.join(', ')}\n` +
    `Tags now: ${current.length > 0 ? current.join(', ') : '(none)'}`
  )
}
