import { query } from '../db/postgres.js'

// Is the embedding queue actually being worked off, and when does it end?
//
// "37,960 pending" on its own cannot answer that: the same number means the
// pipeline is healthy and nearly done, or that it stalled hours ago, or that
// new messages are arriving faster than they can be vectorised. The difference
// is a rate, so this measures two of them over a recent window — how fast
// messages are being embedded, and how fast new ones are arriving — and reports
// the difference, which is the only number an ETA can honestly come from.

type QueueState =
  // Nothing left to embed.
  | 'caught-up'
  // Work is happening and the backlog is shrinking.
  | 'draining'
  // Work is happening but new messages arrive at the same rate.
  | 'holding'
  // Work is happening and losing: the backlog grew over the window.
  | 'falling-behind'
  // A backlog exists and nothing was embedded in the window at all.
  | 'stalled'

export type ThroughputReport = {
  state: QueueState
  queue: { pending: number; embedded: number }
  rates: {
    embeddedPerMinute: number
    arrivedPerMinute: number
    // Positive means the backlog is shrinking by this much each minute.
    netDrainPerMinute: number
  }
  eta: {
    // Null whenever the backlog is not shrinking — an ETA computed from a
    // non-positive drain rate is either infinite or negative, and printing
    // either as a time is worse than admitting there isn't one.
    secondsRemaining: number | null
    finishesAt: string | null
  }
  window: { minutes: number; embedded: number; arrived: number }
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
  windowMinutes: number
  now: Date
}): ThroughputReport => {
  const { pending, embeddedTotal, embeddedInWindow, arrivedInWindow, windowMinutes, now } = input

  const embeddedPerMinute = round(embeddedInWindow / windowMinutes)
  const arrivedPerMinute = round(arrivedInWindow / windowMinutes)
  const netDrainPerMinute = round(embeddedPerMinute - arrivedPerMinute)

  const state: QueueState =
    pending === 0
      ? 'caught-up'
      : embeddedInWindow === 0
        ? 'stalled'
        : netDrainPerMinute > 0
          ? 'draining'
          : netDrainPerMinute < 0
            ? 'falling-behind'
            : 'holding'

  const secondsRemaining =
    state === 'caught-up'
      ? 0
      : state === 'draining'
        ? Math.round((pending / netDrainPerMinute) * 60)
        : null

  return {
    state,
    queue: { pending, embedded: embeddedTotal },
    rates: { embeddedPerMinute, arrivedPerMinute, netDrainPerMinute },
    eta: {
      secondsRemaining,
      finishesAt:
        secondsRemaining === null ? null : new Date(now.getTime() + secondsRemaining * 1000).toISOString(),
    },
    window: { minutes: windowMinutes, embedded: embeddedInWindow, arrived: arrivedInWindow },
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

// `pending` and the embeddable filter deliberately match /status's definition
// (content_text over 10 chars, no row in convo-messages) — two screens
// disagreeing about how much work is left is worse than either number alone.
export const getThroughput = async (windowMinutes: number): Promise<ThroughputReport> => {
  const [pending, embeddedTotal, embeddedInWindow, arrivedInWindow] = await Promise.all([
    query<{ count: string }>(`
      SELECT COUNT(*) as count FROM messages m
      LEFT JOIN embeddings e ON e.message_id = m.id AND e.chroma_collection = 'convo-messages'
      WHERE m.content_text IS NOT NULL AND LENGTH(m.content_text) > 10 AND e.id IS NULL
    `),
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
  ])

  const n = (r: { rows: { count: string }[] }) => parseInt(r.rows[0]?.count ?? '0', 10)

  return summarizeThroughput({
    pending: n(pending),
    embeddedTotal: n(embeddedTotal),
    embeddedInWindow: n(embeddedInWindow),
    arrivedInWindow: n(arrivedInWindow),
    windowMinutes,
    now: new Date(),
  })
}
