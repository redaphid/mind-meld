import assert from 'node:assert'
import { config } from '../config.js'
import { query } from '../db/postgres.js'
import { findAutomatedDrift } from '../embeddings/automated-flags.js'
import { notWarmup } from './title.js'
import { isRepetitionLoop, LOOP_MIN_CHARS } from '../embeddings/repetition-loop.js'

// Bad-summary signal SQL is kept in lockstep with scripts/audit-summaries.sh and
// scripts/reset-bad-summaries.ts. If you change a signal there, change it here too.
// `loopy` is the exception: it is not SQL. $1 carries loopingSummaryIds(), so
// every audit uses the summarizer's own isRepetitionLoop.
// The `unsummarizable` marker ([unsummarizable]…) is health-tool-only: those are
// summaries the pipeline gave up on, which still count against quality.
const BAD_SUMMARY_SIGNALS = `
  WITH scored AS (
    SELECT
      s.id,
      (s.summary ~ '^\\[(USER|ASSISTANT|SYSTEM|TOOL)\\]:' AND s.content_chars > 8000) AS truncated,
      (s.summary IN ('No embeddable content','Embedding generation failed')) AS marker_only,
      (s.summary ~* '^\\s*(NO_UPDATE|NO UPDATE|N/A|None)\\s*$') AS no_update,
      (s.summary ~* '^\\s*(<done>|</?think>|BLOCKED|ERROR:|I cannot|I am unable|I''m unable|I will not)') AS refusal,
      (s.content_chars > 8000
        AND ((LENGTH(s.summary) - LENGTH(REPLACE(s.summary, '[USER]:', '')))
           + (LENGTH(s.summary) - LENGTH(REPLACE(s.summary, '[ASSISTANT]:', '')))) > 14
      ) AS raw_message_leak,
      (LENGTH(s.summary) < 500 AND s.content_chars > 8000) AS too_short,
      (s.content_chars > 5000
        AND LENGTH(s.summary)::numeric / NULLIF(s.content_chars, 0) < 0.005) AS over_compressed,
      (s.id = ANY($1::int[])) AS loopy,
      (s.summary ~ '^\\s*\\{' AND s.summary ~ '"file_paths"\\s*:') AS json_dump,
      (s.content_chars > 8000
        AND (LENGTH(s.summary) - LENGTH(REPLACE(s.summary, REPEAT(CHR(96), 3), ''))) / 3 >= 4
      ) AS code_dump,
      (s.summary LIKE '[unsummarizable]%') AS unsummarizable
    FROM sessions s
    WHERE s.summary IS NOT NULL
      AND s.deleted_at IS NULL
      AND ${notWarmup('s')}
  )
`

const BAD_SUMMARY_CATEGORIES = [
  'truncated',
  'marker_only',
  'no_update',
  'refusal',
  'raw_message_leak',
  'too_short',
  'over_compressed',
  'loopy',
  'json_dump',
  'code_dump',
  'unsummarizable',
] as const

type BadSummaryCategory = (typeof BAD_SUMMARY_CATEGORIES)[number]

export type HealthMetrics = {
  totalSessions: number
  summarizedSessions: number
  coveragePct: number
  nullBacklog: number
  badSummaryTotal: number
  badSummaryByCategory: Record<BadSummaryCategory, number>
  sessionEmbeddingAgeSeconds: number | null
  messageEmbeddingAgeSeconds: number | null
  pendingMessageEmbeddings: number
  // Live sessions whose stored automated flag disagrees with this process's
  // classifier (findAutomatedDrift). `unflagged` should be flagged and is not;
  // sync sets those. `unexplained` is flagged by a rule this process does not
  // hold; only scripts/backfill-automated.ts clears those, on purpose.
  automatedFlagDrift: { unflagged: number; unexplained: number }
}

const gatherCoverage = async () => {
  const result = await query<{
    total: string
    summarized: string
    null_backlog: string
  }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (
         WHERE summary IS NOT NULL AND deleted_at IS NULL AND is_automated = false AND ${notWarmup()}
       ) AS summarized,
       COUNT(*) FILTER (
         WHERE summary IS NULL AND deleted_at IS NULL AND is_automated = false AND ${notWarmup()} AND message_count > 0
       ) AS null_backlog
     FROM sessions`
  )
  const row = result.rows[0]
  assert(row, 'coverage query returned no rows')
  return {
    total: Number(row.total),
    summarized: Number(row.summarized),
    nullBacklog: Number(row.null_backlog),
  }
}

// Verbatim transcripts are stored as `[ROLE]: ...` lines (batch.ts formats
// them so), and a conversation that repeats itself is not a summarizer fault;
// everything else in sessions.summary is model output.
const VERBATIM_TRANSCRIPT = `'^\\[[A-Z_]+\\]:'`
const LOOP_SCAN_PAGE = 500

export const loopingSummaryIds = async (): Promise<number[]> => {
  const ids: number[] = []
  let after = 0
  for (;;) {
    const page = await query<{ id: number; summary: string }>(
      `SELECT id, summary FROM sessions
       WHERE summary IS NOT NULL AND id > $1
         AND LENGTH(summary) >= $2 AND summary !~ ${VERBATIM_TRANSCRIPT}
       ORDER BY id LIMIT $3`,
      [after, LOOP_MIN_CHARS, LOOP_SCAN_PAGE]
    )
    for (const row of page.rows) if (isRepetitionLoop(row.summary)) ids.push(row.id)
    if (page.rows.length < LOOP_SCAN_PAGE) return ids
    after = page.rows[page.rows.length - 1].id
  }
}

const gatherBadSummaries = async () => {
  const counters = BAD_SUMMARY_CATEGORIES.map(
    (cat) => `COUNT(*) FILTER (WHERE ${cat}) AS ${cat}`
  ).join(',\n       ')
  const anyClause = BAD_SUMMARY_CATEGORIES.join(' OR ')

  const result = await query<Record<BadSummaryCategory | 'any_bad', string>>(
    `${BAD_SUMMARY_SIGNALS}
     SELECT
       ${counters},
       COUNT(*) FILTER (WHERE ${anyClause}) AS any_bad
     FROM scored`,
    [await loopingSummaryIds()]
  )
  const row = result.rows[0]
  assert(row, 'bad-summary query returned no rows')

  const byCategory = Object.fromEntries(
    BAD_SUMMARY_CATEGORIES.map((cat) => [cat, Number(row[cat])])
  ) as Record<BadSummaryCategory, number>

  return { total: Number(row.any_bad), byCategory }
}

const gatherEmbeddingHealth = async () => {
  const result = await query<{
    sessions_age_s: string | null
    messages_age_s: string | null
    pending_msgs: string
  }>(
    `SELECT
       (SELECT EXTRACT(EPOCH FROM NOW() - MAX(created_at))::int
        FROM embeddings WHERE chroma_collection = $1) AS sessions_age_s,
       (SELECT EXTRACT(EPOCH FROM NOW() - MAX(created_at))::int
        FROM embeddings WHERE chroma_collection = $2) AS messages_age_s,
       (SELECT COUNT(*)
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        LEFT JOIN embeddings e ON m.id = e.message_id AND e.chroma_collection = $2
        LEFT JOIN embeddings skip ON skip.message_id = m.id AND skip.chroma_collection = 'UNEMBEDDABLE'
        WHERE e.id IS NULL AND skip.id IS NULL
          AND s.deleted_at IS NULL
          AND s.is_automated = false
          AND m.role <> 'tool'
          AND m.content_text IS NOT NULL
          AND LENGTH(m.content_text) > 10) AS pending_msgs`,
    [config.chroma.collections.sessions, config.chroma.collections.messages]
  )
  const row = result.rows[0]
  assert(row, 'embedding-health query returned no rows')
  return {
    sessionEmbeddingAgeSeconds: row.sessions_age_s === null ? null : Number(row.sessions_age_s),
    messageEmbeddingAgeSeconds: row.messages_age_s === null ? null : Number(row.messages_age_s),
    pendingMessageEmbeddings: Number(row.pending_msgs),
  }
}

export const getHealth = async (): Promise<HealthMetrics> => {
  const coverage = await gatherCoverage()
  const bad = await gatherBadSummaries()
  const embeddings = await gatherEmbeddingHealth()
  const drift = await findAutomatedDrift()

  const denominator = coverage.summarized + coverage.nullBacklog
  const coveragePct = denominator === 0 ? 100 : (coverage.summarized / denominator) * 100

  return {
    totalSessions: coverage.total,
    summarizedSessions: coverage.summarized,
    coveragePct,
    nullBacklog: coverage.nullBacklog,
    badSummaryTotal: bad.total,
    badSummaryByCategory: bad.byCategory,
    ...embeddings,
    automatedFlagDrift: {
      unflagged: drift.filter((d) => !d.stored).length,
      unexplained: drift.filter((d) => d.stored).length,
    },
  }
}

const formatAge = (seconds: number | null): string => {
  if (seconds === null) return 'never (no embeddings)'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export const formatHealth = (h: HealthMetrics): string => {
  const coverageStr = h.coveragePct.toFixed(1)
  const badBreakdown = BAD_SUMMARY_CATEGORIES.filter((c) => h.badSummaryByCategory[c] > 0)
    .map((c) => `  - ${c}: ${h.badSummaryByCategory[c]}`)
    .join('\n')

  return `# Mindmeld Health

## Summary Coverage
- Total sessions: ${h.totalSessions}
- Sessions with summary (excl. deleted + Warmup): ${h.summarizedSessions}
- **Coverage: ${coverageStr}%** (summarized / (summarized + NULL backlog))
- NULL-summary backlog (real, message_count > 0): ${h.nullBacklog}

## Summary Quality
- Bad-summary total: ${h.badSummaryTotal}
${badBreakdown || '  - (none)'}

## Embedding Freshness
- Last session embedding: ${formatAge(h.sessionEmbeddingAgeSeconds)}
- Last message embedding: ${formatAge(h.messageEmbeddingAgeSeconds)}
- Pending message embeddings: ${h.pendingMessageEmbeddings}

## Automated Flags: ${h.automatedFlagDrift.unflagged + h.automatedFlagDrift.unexplained === 0 ? 'HEALTHY' : 'UNHEALTHY'} (both should be 0)
- Should be flagged and is not: ${h.automatedFlagDrift.unflagged}
- Flagged, and this process's rule does not explain it: ${h.automatedFlagDrift.unexplained}

---

UNHEALTHY when: coverage drops well below ~95% (summarizer arm degraded);
NULL backlog grows over time instead of draining; bad-summary total climbs
(re-summarization regressed); embedding ages exceed the sync interval (sync or
Ollama stalled); or pending embeddings keep rising (backfill not keeping up); or either automated-flag
count is non-zero: "should be flagged" after a sync run means sync is not
running or cannot write, and "does not explain" means a flag was set under a
prefix list this process lacks (check MINDMELD_AUTOMATED_PREFIXES here) or by a
retired rule (review with scripts/backfill-automated.ts).`
}
