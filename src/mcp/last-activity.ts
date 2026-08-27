// What "recent" means for a session — in one place, because SQL and TypeScript
// both need the rule and a search that disagrees with its own filter is a bug
// nothing fails on.
//
// `started_at` is when the FIRST message ever landed in the session, and a
// session key can be far coarser than a conversation: an SMS thread keyed on
// threadId spans years. Filtering or sorting recency on it therefore hides
// messages that arrived minutes ago inside an old session — observed live, a
// query that returned a hit returned nothing once `since=6h` was added, for a
// message 18 minutes old. The same column charted a thread active tonight as a
// bar in 2014.
//
// `ended_at` is MAX(m.timestamp), maintained by `update_session_stats()`
// (init-db/003-ensure-functions.sql). It was verified non-null and never
// inverted across every live session, so the COALESCE is defence, not doubt —
// it keeps a session whose stats have not been computed yet sorting on
// something rather than on NULL.
//
// This is deliberately NOT the same question as "when did this session start".
// `startedAt` fields (the session digest, /status' latestSession) still mean
// first message and must keep reading `started_at`.

// Assumes the sessions table is aliased `s`, as it is everywhere this is used.
export const LAST_ACTIVITY_SQL = 'COALESCE(s.ended_at, s.started_at)'

export const lastActivity = (s: { started_at: Date; ended_at: Date | null }): Date =>
  s.ended_at ?? s.started_at
