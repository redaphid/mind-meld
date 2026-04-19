#!/bin/bash
# Audit session summaries for common failure modes:
#   - truncation (old fallback path wrote raw [USER]:/[ASSISTANT]: text)
#   - repetition loops (qwen generating same n-gram forever)
#   - refusals / prompt-injection mimicry (<done>, BLOCKED, etc.)
#   - impossibly short relative to source content
#   - marker-only values (e.g. "Embedding generation failed")
#
# Usage:
#   ./scripts/audit-summaries.sh             # summary counts
#   ./scripts/audit-summaries.sh samples     # show samples per category
#   ./scripts/audit-summaries.sh ids <cat>   # just print IDs for one category
set -euo pipefail

MODE="${1:-summary}"
CATEGORY="${2:-}"

psql() {
  docker exec -i mindmeld-postgres psql -U mindmeld -d conversations "$@"
}

read -r -d '' SIGNALS_CTE <<'SQL' || true
WITH scored AS (
  SELECT
    s.id,
    src.name AS source,
    LEFT(s.title, 60) AS title,
    s.message_count,
    s.content_chars,
    LENGTH(s.summary) AS summary_len,
    s.summary,
    -- Truncation fallback: old code wrote raw concatenated messages on summarizer failure.
    -- Signature: starts with a role marker AND content is large enough that summarization should have run.
    (s.summary ~ '^\[(USER|ASSISTANT|SYSTEM|TOOL)\]:'
      AND s.content_chars > 8000) AS truncated,
    -- Exact length fingerprints of the two fallback paths (5000 and 24000 chars).
    (LENGTH(s.summary) BETWEEN 4990 AND 5010) AS len_5k,
    (LENGTH(s.summary) BETWEEN 23990 AND 24010) AS len_24k,
    -- Known marker strings from markSessionProcessed.
    (s.summary IN ('No embeddable content','Embedding generation failed')) AS marker_only,
    -- Agent-shaped "no change" response leaking through as a summary.
    (s.summary ~* '^\s*(NO_UPDATE|NO UPDATE|N/A|None)\s*$') AS no_update,
    -- Refusal / prompt-injection mimicry.
    (s.summary ~* '^\s*(<done>|</?think>|BLOCKED|ERROR:|I cannot|I am unable|I''m unable|I will not)') AS refusal,
    -- Raw-message leak: role markers in a summary that *should* have been compressed.
    -- For content under MAX_CHARS_BEFORE_SUMMARIZE (8000) concatenation is legitimate, so skip those.
    (s.content_chars > 8000
      AND ((LENGTH(s.summary) - LENGTH(REPLACE(s.summary, '[USER]:', '')))
         + (LENGTH(s.summary) - LENGTH(REPLACE(s.summary, '[ASSISTANT]:', '')))) > 14
    ) AS raw_message_leak,
    -- Too short: huge input, tiny summary.
    (LENGTH(s.summary) < 500 AND s.content_chars > 8000) AS too_short,
    -- Compression too extreme: summary less than 0.5% of source.
    (s.content_chars > 5000
      AND LENGTH(s.summary)::numeric / NULLIF(s.content_chars, 0) < 0.005) AS over_compressed,
    -- Loop detector: very low distinct-word ratio on long output = token-generation loop.
    -- Tightened to < 0.05 to avoid flagging real multi-topic summaries.
    CASE
      WHEN LENGTH(s.summary) > 2000
       AND array_length(string_to_array(s.summary, ' '), 1) > 300
       AND (
         SELECT COUNT(DISTINCT w)::numeric
           / NULLIF(array_length(string_to_array(s.summary, ' '), 1), 0)
         FROM unnest(string_to_array(s.summary, ' ')) AS w
       ) < 0.05
      THEN true ELSE false
    END AS loopy,
    -- Bare JSON dump (no prose).
    (s.summary ~ '^\s*\{' AND s.summary ~ '"file_paths"\s*:') AS json_dump
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  JOIN sources src ON src.id = p.source_id
  WHERE s.summary IS NOT NULL
)
SQL

case "$MODE" in
  summary)
    psql <<SQL
$SIGNALS_CTE
SELECT
  source,
  COUNT(*)                                   AS total_with_summary,
  COUNT(*) FILTER (WHERE truncated)          AS truncated,
  COUNT(*) FILTER (WHERE len_5k)             AS len_5k,
  COUNT(*) FILTER (WHERE len_24k)            AS len_24k,
  COUNT(*) FILTER (WHERE marker_only)        AS marker_only,
  COUNT(*) FILTER (WHERE no_update)          AS no_update,
  COUNT(*) FILTER (WHERE refusal)            AS refusal,
  COUNT(*) FILTER (WHERE raw_message_leak)   AS raw_leak,
  COUNT(*) FILTER (WHERE too_short)          AS too_short,
  COUNT(*) FILTER (WHERE over_compressed)    AS over_compressed,
  COUNT(*) FILTER (WHERE loopy)              AS loopy,
  COUNT(*) FILTER (WHERE json_dump)          AS json_dump,
  COUNT(*) FILTER (WHERE truncated OR marker_only OR no_update OR refusal
                      OR raw_message_leak OR too_short OR over_compressed
                      OR loopy OR json_dump) AS any_bad
FROM scored
GROUP BY source
ORDER BY source;
SQL
    ;;

  samples)
    for cat in truncated marker_only no_update refusal raw_message_leak too_short over_compressed loopy json_dump; do
      echo "=== $cat ==="
      psql -P pager=off <<SQL
$SIGNALS_CTE
SELECT id, source, summary_len, content_chars, LEFT(regexp_replace(summary, E'\\s+', ' ', 'g'), 160) AS preview
FROM scored
WHERE $cat
ORDER BY random()
LIMIT 3;
SQL
    done
    ;;

  ids)
    [[ -z "$CATEGORY" ]] && { echo "usage: $0 ids <truncated|marker_only|no_update|refusal|raw_message_leak|too_short|over_compressed|loopy|json_dump|any>" >&2; exit 1; }
    WHERE_CLAUSE="$CATEGORY"
    [[ "$CATEGORY" == "any" ]] && WHERE_CLAUSE="truncated OR marker_only OR no_update OR refusal OR raw_message_leak OR too_short OR over_compressed OR loopy OR json_dump"
    psql -tAc "$(cat <<SQL
$SIGNALS_CTE
SELECT id FROM scored WHERE $WHERE_CLAUSE ORDER BY id
SQL
)"
    ;;

  *)
    echo "usage: $0 [summary|samples|ids <category>]" >&2
    exit 1
    ;;
esac
