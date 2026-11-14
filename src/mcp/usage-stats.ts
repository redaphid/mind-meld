// Search usage numbers, from search_log only. One SQL statement serves the
// `stats` tool, GET /api/stats and the UI card, so the three cannot disagree.
// Aggregates only: no query text, caller or session id leaves this module.
import { query } from '../db/postgres.js'
import type { ArmMs } from './search.js'

export const STATS_WINDOWS = [7, 30] as const

// An open counts toward its search only inside this window.
export const OPEN_WINDOW_MINUTES = 10

// Measurement traffic, kept out of usage numbers. Matched on the client name
// without its "/version".
export const EXCLUDED_CLIENTS = ['bench', 'eval']

// Each vector-math search parameter and the request keys that carry it. MCP
// uses the tool's names; REST spells negativeQuery `not`.
export const VECTOR_PARAMS = {
  negativeQuery: ['negativeQuery', 'not'],
  likeSession: ['likeSession'],
  unlikeSession: ['unlikeSession'],
  likeProject: ['likeProject'],
  unlikeProject: ['unlikeProject'],
} as const satisfies Record<string, readonly string[]>

type VectorParam = keyof typeof VECTOR_PARAMS

// Every stage search_log.timings carries besides totalMs. A Record rather than a
// list so a stage added to ArmMs fails to compile until it is named here.
const STAGE_KEYS = {
  semanticMs: true, embedMs: true, sessionMs: true, chunkMs: true, messageMs: true, fullTextMs: true,
} as const satisfies Record<keyof ArmMs, true>
export const STAGES = Object.keys(STAGE_KEYS) as (keyof ArmMs)[]

type Percentiles = { p50: number | null; p90: number | null }

export type UsageStats = {
  days: number
  searches: number
  // UTC days.
  perDay: { day: string; client: string; mode: string | null; searches: number }[]
  // Rates are over searches that did not throw; null when there were none.
  openedShare: number | null
  // The first open of each search, when it was in that search's results.
  openedRank: { opens: number; median: number | null; mrr: number | null }
  noResultRate: number | null
  degradedRate: number | null
  latencyMs: Percentiles
  // Each stage over the searches it ran in. Stages overlap, so they do not sum
  // to latencyMs.
  stageMs: Record<keyof ArmMs, Percentiles>
  // Tag and report calls per search that did not throw.
  feedbackPerSearch: number | null
  // Searches that set each parameter.
  vectorParams: Record<VectorParam, number>
}

const USAGE_SQL = `
WITH w AS (
  SELECT * FROM search_log
  WHERE at >= now() - make_interval(days => $1)
    AND split_part(client, '/', 1) <> ALL ($2::text[])
), s AS (
  SELECT * FROM w WHERE kind = 'search'
), ok AS (
  SELECT * FROM s WHERE error IS NULL
), first_open AS (
  -- One index probe per search on search_log_list_idx. A join over the window
  -- CTE planned as a nested loop and took 30 s on 100k rows.
  SELECT s.id, o.rank FROM ok s
  CROSS JOIN LATERAL (
    SELECT o.rank FROM search_log o
    WHERE o.list = s.list AND o.kind = 'open'
      AND o.at >= s.at AND o.at <= s.at + make_interval(mins => $3)
      AND o.at >= now() - make_interval(days => $1)
      AND split_part(o.client, '/', 1) <> ALL ($2::text[])
    ORDER BY o.at, o.id LIMIT 1) o
)
SELECT
  (SELECT count(*) FROM s)::int AS searches,
  (SELECT count(*) FROM ok)::int AS ok,
  (SELECT count(*) FROM first_open)::int AS opened,
  (SELECT count(rank) FROM first_open)::int AS ranked,
  (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY rank) FROM first_open) AS median_rank,
  (SELECT avg(1.0 / rank)::float8 FROM first_open) AS mrr,
  (SELECT count(*) FROM ok WHERE result_count = 0)::int AS no_result,
  (SELECT count(*) FROM ok WHERE degraded IS NOT NULL)::int AS degraded,
  (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (timings->>'totalMs')::float8) FROM ok) AS p50,
  (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY (timings->>'totalMs')::float8) FROM ok) AS p90,
  (SELECT count(*) FROM w WHERE kind = 'tag')::int AS feedback,
  (SELECT jsonb_object_agg(p.key, (
     SELECT count(*) FROM s WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(p.value) k
       WHERE COALESCE(s.request -> k, 'null'::jsonb) NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb, 'false'::jsonb))))
   FROM jsonb_each($4::jsonb) p) AS vector_params,
  (SELECT jsonb_object_agg(k, jsonb_build_object(
     'p50', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (ok.timings->>k)::float8) FROM ok),
     'p90', (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY (ok.timings->>k)::float8) FROM ok)))
   FROM unnest($5::text[]) k) AS stage_ms,
  (SELECT COALESCE(jsonb_agg(d ORDER BY d.day, d.client, d.mode), '[]'::jsonb) FROM (
     SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            split_part(client, '/', 1) AS client, mode, count(*)::int AS searches
     FROM s GROUP BY 1, 2, 3) d) AS per_day`

type UsageRow = {
  searches: number
  ok: number
  opened: number
  ranked: number
  median_rank: number | null
  mrr: number | null
  no_result: number
  degraded: number
  p50: number | null
  p90: number | null
  feedback: number
  vector_params: Record<VectorParam, number>
  stage_ms: Record<keyof ArmMs, Percentiles>
  per_day: UsageStats['perDay']
}

const share = (part: number, whole: number) => (whole === 0 ? null : part / whole)

export const toUsageStats = (days: number, row: UsageRow): UsageStats => ({
  days,
  searches: row.searches,
  perDay: row.per_day,
  openedShare: share(row.opened, row.ok),
  openedRank: { opens: row.ranked, median: row.median_rank, mrr: row.mrr },
  noResultRate: share(row.no_result, row.ok),
  degradedRate: share(row.degraded, row.ok),
  latencyMs: { p50: row.p50, p90: row.p90 },
  stageMs: row.stage_ms,
  feedbackPerSearch: share(row.feedback, row.ok),
  vectorParams: row.vector_params,
})

export const usageStats = async (days: number): Promise<UsageStats> => {
  const { rows } = await query<UsageRow>(USAGE_SQL, [
    days, EXCLUDED_CLIENTS, OPEN_WINDOW_MINUTES, JSON.stringify(VECTOR_PARAMS), STAGES,
  ])
  return toUsageStats(days, rows[0])
}

const pct = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`)
const num = (n: number | null, digits = 1) => (n === null ? 'n/a' : n.toFixed(digits))

export const formatUsageStats = (windows: UsageStats[]): string => {
  const cols = windows.map((w) => `${w.days}d`)
  const line = (label: string, cell: (w: UsageStats) => string) =>
    `| ${label} | ${windows.map(cell).join(' | ')} |`

  const table = [
    `| | ${cols.join(' | ')} |`,
    `|---|${cols.map(() => '---').join('|')}|`,
    line('Searches', (w) => String(w.searches)),
    line(`Opened within ${OPEN_WINDOW_MINUTES} min`, (w) => pct(w.openedShare)),
    line('Opened rank, median', (w) => num(w.openedRank.median)),
    line('Opened rank, MRR', (w) => num(w.openedRank.mrr, 3)),
    line('No results', (w) => pct(w.noResultRate)),
    line('Degraded', (w) => pct(w.degradedRate)),
    line('Latency p50 ms', (w) => num(w.latencyMs.p50, 0)),
    line('Latency p90 ms', (w) => num(w.latencyMs.p90, 0)),
    ...STAGES.map((stage) =>
      line(`${stage.replace(/Ms$/, '')} p50 / p90 ms`, (w) => `${num(w.stageMs[stage].p50, 0)} / ${num(w.stageMs[stage].p90, 0)}`)),
    line('Feedback per search', (w) => num(w.feedbackPerSearch, 2)),
    ...Object.keys(VECTOR_PARAMS).map((p) =>
      line(`Uses ${p}`, (w) => String(w.vectorParams[p as VectorParam]))),
  ]

  const recent = windows[0]
  const byDay = recent.perDay.length === 0
    ? ['No searches.']
    : recent.perDay.map((d) => `- ${d.day} ${d.client} ${d.mode ?? 'no mode'}: ${d.searches}`)

  return [
    `## Search usage`,
    ``,
    `From the search log. Bench and eval clients are excluded.`,
    ``,
    ...table,
    ``,
    `### Searches per day, last ${recent.days} days (UTC)`,
    ``,
    ...byDay,
    ``,
  ].join('\n')
}
