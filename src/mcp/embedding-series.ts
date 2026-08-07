import { query } from '../db/postgres.js'
import { config } from '../config.js'

// The embedding pipeline over time, as buckets — the shape behind the graph on
// the overview.
//
// `/api/throughput` answers "what is happening now" with a single averaged
// rate. That average cannot distinguish a queue draining steadily from one that
// did all its work in a five-minute burst two hours ago and has been idle since,
// and those call for completely different reactions. So this returns the series
// rather than the mean, and the screen draws it.
//
// Three series, because the pipeline has three flows worth telling apart:
//   - arrived:    messages synced in (cheap, bursty, driven by how much you
//                 talked to Claude)
//   - embedded:   messages vectorised (fast phase, hundreds/minute when the
//                 GPU is free)
//   - summarized: sessions given an LLM summary (slow phase, single digits per
//                 minute at best — plotted on its own scale for that reason)

type EmbeddingBucket = {
  // Bucket start, ISO. Buckets are contiguous and gap-filled: an hour where
  // nothing happened is a zero, never a missing point, because a line chart
  // that silently closes gaps draws idle time as a slope.
  at: string
  arrived: number
  embedded: number
  summarized: number
}

export type EmbeddingSeries = {
  windowMinutes: number
  bucketMinutes: number
  buckets: EmbeddingBucket[]
  totals: { arrived: number; embedded: number; summarized: number }
  peak: { arrived: number; embedded: number; summarized: number }
}

export const DEFAULT_SERIES_MINUTES = 360

// Same reasoning as the throughput window, one day maximum.
export const clampSeriesWindow = (minutes: unknown): number => {
  const n = typeof minutes === 'number' ? minutes : parseInt(String(minutes ?? ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_SERIES_MINUTES
  return Math.min(1440, Math.max(10, Math.round(n)))
}

// Aim for ~60 buckets regardless of window, so the graph has a usable
// resolution at both 1 hour and 24 hours without the caller choosing.
export const bucketSizeFor = (windowMinutes: number): number =>
  Math.max(1, Math.round(windowMinutes / 60))

// One pass over a generated bucket spine, LEFT JOINed to each source. Done in
// SQL rather than in JS because the alternative is pulling every row in the
// window across the wire to count them here.
//
// `embeddings.created_at` is the completion signal for both worked phases, and
// only moves on a row's FIRST write — a re-embed is an upsert and bumps nothing
// — so a pass made entirely of re-embeds under-reports rather than
// over-reports. Same choice, and same reasoning, as getThroughput.
export const getEmbeddingSeries = async (windowMinutes: number): Promise<EmbeddingSeries> => {
  const bucketMinutes = bucketSizeFor(windowMinutes)

  const result = await query<{
    at: Date
    arrived: string
    embedded: string
    summarized: string
  }>(
    `WITH spine AS (
       SELECT generate_series(
         date_bin(($2 || ' minutes')::interval, now() - ($1 || ' minutes')::interval, TIMESTAMPTZ 'epoch'),
         date_bin(($2 || ' minutes')::interval, now(), TIMESTAMPTZ 'epoch'),
         ($2 || ' minutes')::interval
       ) AS at
     ),
     arrived AS (
       SELECT date_bin(($2 || ' minutes')::interval, created_at, TIMESTAMPTZ 'epoch') AS at,
              COUNT(*) AS n
       FROM messages
       WHERE created_at > now() - ($1 || ' minutes')::interval
         AND content_text IS NOT NULL AND LENGTH(content_text) > 10
       GROUP BY 1
     ),
     embedded AS (
       SELECT date_bin(($2 || ' minutes')::interval, created_at, TIMESTAMPTZ 'epoch') AS at,
              COUNT(*) AS n
       FROM embeddings
       WHERE chroma_collection = $3
         AND created_at > now() - ($1 || ' minutes')::interval
       GROUP BY 1
     ),
     summarized AS (
       SELECT date_bin(($2 || ' minutes')::interval, created_at, TIMESTAMPTZ 'epoch') AS at,
              COUNT(*) AS n
       FROM embeddings
       WHERE chroma_collection = $4
         AND created_at > now() - ($1 || ' minutes')::interval
       GROUP BY 1
     )
     SELECT spine.at,
            COALESCE(arrived.n, 0)::text    AS arrived,
            COALESCE(embedded.n, 0)::text   AS embedded,
            COALESCE(summarized.n, 0)::text AS summarized
     FROM spine
     LEFT JOIN arrived    ON arrived.at    = spine.at
     LEFT JOIN embedded   ON embedded.at   = spine.at
     LEFT JOIN summarized ON summarized.at = spine.at
     ORDER BY spine.at`,
    [
      String(windowMinutes),
      String(bucketMinutes),
      config.chroma.collections.messages,
      config.chroma.collections.sessions,
    ]
  )

  const buckets: EmbeddingBucket[] = result.rows.map(r => ({
    at: new Date(r.at).toISOString(),
    arrived: parseInt(r.arrived, 10),
    embedded: parseInt(r.embedded, 10),
    summarized: parseInt(r.summarized, 10),
  }))

  const sum = (key: keyof Omit<EmbeddingBucket, 'at'>) =>
    buckets.reduce((acc, b) => acc + b[key], 0)
  const max = (key: keyof Omit<EmbeddingBucket, 'at'>) =>
    buckets.reduce((acc, b) => Math.max(acc, b[key]), 0)

  return {
    windowMinutes,
    bucketMinutes,
    buckets,
    totals: { arrived: sum('arrived'), embedded: sum('embedded'), summarized: sum('summarized') },
    peak: { arrived: max('arrived'), embedded: max('embedded'), summarized: max('summarized') },
  }
}
