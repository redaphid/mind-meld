import { query } from '../db/postgres.js'
import { pendingMessagesCount, pendingSessionsCount } from '../embeddings/pending.js'

// Is the embedding queue actually being worked off, and when does it end?
//
// "37,960 pending" on its own cannot answer that: the same number means the
// pipeline is healthy and nearly done, or that it stalled hours ago, or that
// new messages are arriving faster than they can be vectorised. The difference
// is a rate, so this measures two of them over a recent window — how fast
// messages are being embedded, and how fast new ones are arriving — and reports
// the difference, which is the only number an ETA can honestly come from.
//
// The pipeline has two phases, though, and they move at wildly different
// speeds: message embedding (fast, thousands per hour) and session
// summarization (slow, an LLM pass per session). Measuring only the first one
// made the dashboard report `stalled` — "nothing embedded in the last 60m" —
// during the exact runs where the machine was working hardest, because
// `updateAggregateEmbeddings` writes to `convo-sessions`, not `convo-messages`
// (#109). So both phases are measured, and a phase that is moving outranks the
// verdict that nothing is.

type QueueState =
  // Nothing left to embed.
  | 'caught-up'
  // Work is happening and the backlog is shrinking.
  | 'draining'
  // Work is happening but new messages arrive at the same rate.
  | 'holding'
  // Work is happening and losing: the backlog grew over the window.
  | 'falling-behind'
  // No messages were embedded, but sessions were summarized: the slow phase of
  // the pipeline is running. Healthy work, just not the work the message rate
  // can see.
  | 'summarizing'
  // A backlog exists and NEITHER phase advanced in the window.
  | 'stalled'

export type ThroughputReport = {
  state: QueueState
  queue: {
    pending: number
    embedded: number
    // Sessions still owed a summary embedding — the same count /status reports
    // as `pendingEmbeddings.sessions`.
    summariesPending: number
  }
  rates: {
    embeddedPerMinute: number
    arrivedPerMinute: number
    // Positive means the backlog is shrinking by this much each minute.
    netDrainPerMinute: number
    // Sessions summarized per minute. An order of magnitude slower than the
    // message rate — it is normal for this to read 0.05 while the box is busy.
    summarizedPerMinute: number
  }
  eta: {
    // Null whenever the backlog is not shrinking — an ETA computed from a
    // non-positive drain rate is either infinite or negative, and printing
    // either as a time is worse than admitting there isn't one.
    secondsRemaining: number | null
    finishesAt: string | null
  }
  window: { minutes: number; embedded: number; arrived: number; summarized: number }
}

const round = (n: number, places = 2) => {
  const f = 10 ** places
  return Math.round(n * f) / f
}

export const summarizeThroughput = (input: {
  pending: number
  embeddedTotal: number
  embeddedInWindow: number
  arrivedInWindow: number
  summariesPending: number
  summarizedInWindow: number
  windowMinutes: number
  now: Date
}): ThroughputReport => {
  const {
    pending,
    embeddedTotal,
    embeddedInWindow,
    arrivedInWindow,
    summariesPending,
    summarizedInWindow,
    windowMinutes,
    now,
  } = input

  const embeddedPerMinute = round(embeddedInWindow / windowMinutes)
  const arrivedPerMinute = round(arrivedInWindow / windowMinutes)
  const netDrainPerMinute = round(embeddedPerMinute - arrivedPerMinute)
  const summarizedPerMinute = round(summarizedInWindow / windowMinutes)

  // Ranked, most specific first. Order is the whole fix, so it is spelled out
  // rather than nested into one ternary:
  const queueState = (): QueueState => {
    // 1. Messages are moving and some remain: the existing three-way verdict,
    //    which is also the only branch that can honestly produce an ETA.
    if (embeddedInWindow > 0 && pending > 0)
      return netDrainPerMinute > 0 ? 'draining' : netDrainPerMinute < 0 ? 'falling-behind' : 'holding'

    // 2. Nothing embedded, but sessions were summarized and more are owed one.
    //    This outranks `stalled` (#109) — and outranks `caught-up` too, because
    //    "Caught up" while the slowest phase still has a queue is the same lie
    //    pointed the other way.
    if (summarizedInWindow > 0 && summariesPending > 0) return 'summarizing'

    // 3. No messages left to embed. `summariesPending` follows /status, which
    //    counts sessions the embedder itself filters out (warmups, automated
    //    and still-active ones), so it never fully reaches zero on a live box.
    //    A residual count like that must not be allowed to read as a stall.
    if (pending === 0) return 'caught-up'

    // 4. A backlog exists and neither phase advanced. Now it is a stall.
    return 'stalled'
  }

  const state = queueState()

  const secondsRemaining =
    state === 'caught-up'
      ? 0
      : state === 'draining'
        ? Math.round((pending / netDrainPerMinute) * 60)
        : null

  return {
    state,
    queue: { pending, embedded: embeddedTotal, summariesPending },
    rates: { embeddedPerMinute, arrivedPerMinute, netDrainPerMinute, summarizedPerMinute },
    eta: {
      secondsRemaining,
      finishesAt:
        secondsRemaining === null ? null : new Date(now.getTime() + secondsRemaining * 1000).toISOString(),
    },
    window: {
      minutes: windowMinutes,
      embedded: embeddedInWindow,
      arrived: arrivedInWindow,
      summarized: summarizedInWindow,
    },
  }
}

export const DEFAULT_WINDOW_MINUTES = 60

// A window shorter than a few minutes reads noise as a trend, and one longer
// than a day averages away the thing you opened the dashboard to see.
export const clampWindow = (minutes: unknown): number => {
  const n = typeof minutes === 'number' ? minutes : parseInt(String(minutes ?? ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_WINDOW_MINUTES
  return Math.min(1440, Math.max(1, Math.round(n)))
}

// `pending` matches /status's definition — two screens disagreeing about how
// much work is left is worse than either number alone — and, since both now
// import it from `src/embeddings/pending.ts`, it also matches what the embedder
// will actually pick up.
//
// That second half is the fix. This comment used to claim the two were the same
// thing; they were not. `pending` counted rows `getMessagesToEmbed` skips by
// design: tool messages, deleted and automated sessions, and anything carrying
// an UNEMBEDDABLE marker (noise, or text that failed past its retry budget).
// Observed 2026-08-03: 32,339 reported pending — 30,961 noise-marked, 1,376 in
// deleted sessions, 2 tool messages — against ZERO real work. A residue that
// never drains also pins `state` to `draining` and extrapolates an ETA from
// arrival noise, which is how this file advertised a finish date 14 months out
// for a queue that was already finished.
//
// #108 argues the growth test should be a change test at every site; whether it
// does or not, the predicate now lives in one place and must not be restated
// here.
export const getThroughput = async (windowMinutes: number): Promise<ThroughputReport> => {
  const [
    pending,
    embeddedTotal,
    embeddedInWindow,
    arrivedInWindow,
    summariesPending,
    summarizedInWindow,
  ] = await Promise.all([
    (() => {
      const q = pendingMessagesCount()
      return query<{ count: string }>(q.sql, q.params)
    })(),
    query<{ count: string }>(`
      SELECT COUNT(*) as count FROM embeddings WHERE chroma_collection = 'convo-messages'
    `),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM embeddings
       WHERE chroma_collection = 'convo-messages'
         AND created_at > now() - ($1 || ' minutes')::interval`,
      [String(windowMinutes)]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM messages
       WHERE created_at > now() - ($1 || ' minutes')::interval
         AND content_text IS NOT NULL AND LENGTH(content_text) > 10`,
      [String(windowMinutes)]
    ),
    (() => {
      const q = pendingSessionsCount('convo-sessions')
      return query<{ count: string }>(q.sql, q.params)
    })(),
    // The completion signal for the slow phase: `updateAggregateEmbeddings`
    // writes this row immediately after the summary comes back from the LLM,
    // so a row here means a session finished, not that one was attempted.
    // Counted by `created_at`, which only moves for a session's FIRST summary:
    // a re-embed is an upsert, and nothing in that path bumps a timestamp. So
    // this under-reports a pass made entirely of re-embeds rather than
    // over-reporting it — a count that decides "is it working" should fail
    // toward the pessimistic answer, not the flattering one.
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM embeddings
       WHERE chroma_collection = 'convo-sessions'
         AND created_at > now() - ($1 || ' minutes')::interval`,
      [String(windowMinutes)]
    ),
  ])

  const n = (r: { rows: { count: string }[] }) => parseInt(r.rows[0]?.count ?? '0', 10)

  return summarizeThroughput({
    pending: n(pending),
    embeddedTotal: n(embeddedTotal),
    embeddedInWindow: n(embeddedInWindow),
    arrivedInWindow: n(arrivedInWindow),
    summariesPending: n(summariesPending),
    summarizedInWindow: n(summarizedInWindow),
    windowMinutes,
    now: new Date(),
  })
}
