import { query } from '../db/postgres.js'
import { config } from '../config.js'
import { pendingSessionsCount, embeddableSessions } from '../embeddings/pending.js'

// Session summarization: the slow phase, given its own status.
//
// Message embedding is fast enough that a rate describes it well. Summarization
// is not — a chunk pass is 18-110s, a long session is ~8 chunks, so one session
// is 5-10 minutes of a single shared GPU. At that speed a per-minute average
// rounds to something like 0.05 and tells you nothing, while the questions that
// actually matter are: is a session being worked right now, which one, and how
// far back does the queue reach.

export type SummaryStatus = {
  model: string
  sessions: { total: number; summarized: number; pending: number }
  // The oldest session still owed a summary. How far behind the slow phase is,
  // in a unit that means something — a date, not a count.
  oldestPendingStartedAt: string | null
  // Sessions whose summary landed most recently.
  recent: { id: number; title: string | null; at: string }[]
  // What the workers are summarizing right now, read from the log stream. The
  // summarizer emits a line per chunk, so a session appearing here within the
  // last few minutes is a session actively holding the GPU.
  //
  // `workers` counts DISTINCT machine/service pairs on the same session. More
  // than one is not a display quirk: the embedding queue is global and nothing
  // claims a row, so several workers genuinely summarize the same session at
  // once and throw away each other's output. Surfacing the count is how that
  // stops being invisible.
  active: { sessionId: number; chunkPasses: number; workers: number; lastAt: string }[]
}

// Long enough to still show a session between two slow chunk passes, short
// enough that a finished session drops off promptly.
const ACTIVE_WINDOW_MINUTES = 10

export const getSummaryStatus = async (): Promise<SummaryStatus> => {
  const pendingQuery = pendingSessionsCount(config.chroma.collections.sessions)

  const [totals, pending, oldest, recent, active] = await Promise.all([
    query<{ total: string; summarized: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE summary IS NOT NULL)::text AS summarized
       FROM sessions WHERE deleted_at IS NULL`
    ),
    query<{ count: string }>(pendingQuery.sql, pendingQuery.params),
    // Same predicate as the count above, asked for its oldest row instead of
    // its size — embeddableSessions is a FROM/WHERE fragment, so ordering it
    // is the supported way to ask this and cannot drift from the count.
    query<{ started_at: Date | null }>(
      `SELECT s.started_at
       ${embeddableSessions('$1')}
       ORDER BY s.started_at ASC NULLS LAST
       LIMIT 1`,
      [config.chroma.collections.sessions]
    ),
    // Session-level embeddings carry no session_id column — they are keyed by
    // `chroma_id` of the form `session-<id>`, so that is what the join has to
    // parse. `message_id` on these rows points at a message, not the session,
    // and joining through it would silently attribute the summary to whichever
    // message happened to be stamped there.
    query<{ id: number; title: string | null; created_at: Date }>(
      `SELECT s.id, s.title, e.created_at
       FROM embeddings e
       JOIN sessions s ON s.id = substring(e.chroma_id from 'session-([0-9]+)')::bigint
       WHERE e.chroma_collection = $1
         AND e.chroma_id ~ '^session-[0-9]+$'
       ORDER BY e.created_at DESC
       LIMIT 5`,
      [config.chroma.collections.sessions]
    ),
    query<{ sess: string; chunk_passes: string; workers: string; last_at: Date }>(
      `WITH s AS (
         SELECT machine || '/' || service AS who,
                substring(message from 'for session ([0-9]+)') AS sess,
                logged_at
         FROM logs
         WHERE message LIKE 'Summarizing chunk%'
           AND logged_at > now() - ($1 || ' minutes')::interval
       )
       SELECT sess,
              COUNT(*)::text AS chunk_passes,
              COUNT(DISTINCT who)::text AS workers,
              MAX(logged_at) AS last_at
       FROM s
       WHERE sess IS NOT NULL
       GROUP BY sess
       ORDER BY MAX(logged_at) DESC
       LIMIT 10`,
      [String(ACTIVE_WINDOW_MINUTES)]
    ),
  ])

  return {
    model: config.embeddings.summarizeModel,
    sessions: {
      total: parseInt(totals.rows[0]?.total ?? '0', 10),
      summarized: parseInt(totals.rows[0]?.summarized ?? '0', 10),
      pending: parseInt(pending.rows[0]?.count ?? '0', 10),
    },
    oldestPendingStartedAt: oldest.rows[0]?.started_at
      ? new Date(oldest.rows[0].started_at as Date).toISOString()
      : null,
    recent: recent.rows.map(r => ({
      id: r.id,
      title: r.title,
      at: new Date(r.created_at).toISOString(),
    })),
    active: active.rows.map(r => ({
      sessionId: parseInt(r.sess, 10),
      chunkPasses: parseInt(r.chunk_passes, 10),
      workers: parseInt(r.workers, 10),
      lastAt: new Date(r.last_at).toISOString(),
    })),
  }
}
