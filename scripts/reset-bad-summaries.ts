// Reset sessions whose stored summary matches one of the audit signals so the
// next sync cycle re-summarizes and re-embeds them.
//
// Usage:
//   pnpm tsx scripts/reset-bad-summaries.ts                 # dry run — show counts + sample IDs
//   pnpm tsx scripts/reset-bad-summaries.ts --execute       # delete from Chroma, clear pg summary + embedding row
//   pnpm tsx scripts/reset-bad-summaries.ts --execute --category too_short
//
// The SQL signals here mirror scripts/audit-summaries.sh — keep them in sync.

import { query } from "../src/db/postgres.js";
import { deleteByIds } from "../src/db/chroma.js";
import { config } from "../src/config.js";

const CATEGORIES = [
  "truncated",
  "marker_only",
  "no_update",
  "refusal",
  "raw_message_leak",
  "too_short",
  "over_compressed",
  "loopy",
  "json_dump",
] as const;
type Category = (typeof CATEGORIES)[number];

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const catIdx = args.indexOf("--category");
const onlyCategory =
  catIdx >= 0 ? (args[catIdx + 1] as Category | undefined) : undefined;

if (onlyCategory && !CATEGORIES.includes(onlyCategory)) {
  console.error(`unknown --category ${onlyCategory}. Valid: ${CATEGORIES.join(", ")}`);
  process.exit(1);
}

const SIGNALS_SQL = `
  WITH scored AS (
    SELECT
      s.id,
      s.summary,
      s.content_chars,
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
      (LENGTH(s.summary) > 2000
        AND array_length(string_to_array(s.summary, ' '), 1) > 300
        AND (SELECT COUNT(DISTINCT w)::numeric
               / NULLIF(array_length(string_to_array(s.summary, ' '), 1), 0)
             FROM unnest(string_to_array(s.summary, ' ')) AS w) < 0.05
      ) AS loopy,
      (s.summary ~ '^\\s*\\{' AND s.summary ~ '"file_paths"\\s*:') AS json_dump
    FROM sessions s
    WHERE s.summary IS NOT NULL
  )
`;

const whereForCategory = (cat: Category | undefined): string => {
  if (!cat) return CATEGORIES.join(" OR ");
  return cat;
};

const main = async () => {
  const where = whereForCategory(onlyCategory);

  const rows = await query<{ id: number }>(
    `${SIGNALS_SQL}
     SELECT id FROM scored WHERE ${where} ORDER BY id`,
  );
  const ids = rows.rows.map((r) => r.id);
  console.log(
    `Matched ${ids.length} sessions (category=${onlyCategory ?? "any bad"})`,
  );

  const breakdown = await query<{ cat: string; n: string }>(
    `${SIGNALS_SQL}
     SELECT 'truncated' AS cat, COUNT(*)::text AS n FROM scored WHERE truncated
     UNION ALL SELECT 'marker_only', COUNT(*)::text FROM scored WHERE marker_only
     UNION ALL SELECT 'no_update', COUNT(*)::text FROM scored WHERE no_update
     UNION ALL SELECT 'refusal', COUNT(*)::text FROM scored WHERE refusal
     UNION ALL SELECT 'raw_message_leak', COUNT(*)::text FROM scored WHERE raw_message_leak
     UNION ALL SELECT 'too_short', COUNT(*)::text FROM scored WHERE too_short
     UNION ALL SELECT 'over_compressed', COUNT(*)::text FROM scored WHERE over_compressed
     UNION ALL SELECT 'loopy', COUNT(*)::text FROM scored WHERE loopy
     UNION ALL SELECT 'json_dump', COUNT(*)::text FROM scored WHERE json_dump`,
  );
  console.table(breakdown.rows);

  if (ids.length === 0) return;
  console.log(`Sample IDs: ${ids.slice(0, 10).join(", ")}${ids.length > 10 ? " …" : ""}`);

  if (!execute) {
    console.log("\nDry run. Re-run with --execute to apply.");
    return;
  }

  const sessionsCollection = config.chroma.collections.sessions;
  const chromaIds = ids.map((id) => `session-${id}`);

  console.log(`\nDeleting ${chromaIds.length} entries from Chroma collection "${sessionsCollection}"...`);
  const CHUNK = 500;
  for (let i = 0; i < chromaIds.length; i += CHUNK) {
    await deleteByIds(sessionsCollection, chromaIds.slice(i, i + CHUNK));
  }

  console.log(`Clearing postgres embeddings rows...`);
  const delPg = await query(
    `DELETE FROM embeddings
     WHERE chroma_collection = $1
       AND chroma_id = ANY($2::text[])`,
    [sessionsCollection, chromaIds],
  );
  console.log(`  removed ${delPg.rowCount ?? 0} embedding rows`);

  console.log(`Nullifying sessions.summary so re-summarization picks them up...`);
  const upd = await query(
    `UPDATE sessions SET summary = NULL WHERE id = ANY($1::int[])`,
    [ids],
  );
  console.log(`  cleared ${upd.rowCount ?? 0} session summaries`);

  console.log("\nDone. Next sync cycle's updateAggregateEmbeddings will reprocess these.");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
