import { query, closePool } from "../../src/db/postgres.js";

async function main() {
  // Distribution of session sizes
  const distribution = await query<{ bucket: string; count: number; total_chars: number }>(`
    SELECT
      CASE
        WHEN content_chars < 8000 THEN '< 8k (no summarization)'
        WHEN content_chars < 100000 THEN '8k-100k (single pass)'
        WHEN content_chars < 500000 THEN '100k-500k (chunked)'
        WHEN content_chars < 1000000 THEN '500k-1M (heavily chunked)'
        ELSE '> 1M (mega sessions)'
      END as bucket,
      COUNT(*) as count,
      SUM(content_chars) as total_chars
    FROM sessions
    WHERE content_chars > 0
    GROUP BY 1
    ORDER BY MIN(content_chars)
  `);

  console.log("\n=== Session Size Distribution ===\n");
  console.log("Bucket                      Sessions    Total Chars");
  console.log("────────────────────────────────────────────────────");
  for (const row of distribution.rows) {
    console.log(`${row.bucket.padEnd(28)} ${String(row.count).padStart(8)}    ${Number(row.total_chars).toLocaleString()}`);
  }

  // Top 20 longest sessions
  const longest = await query<{
    id: number;
    title: string;
    content_chars: number;
    message_count: number;
    project_path: string;
    source: string;
  }>(`
    SELECT s.id, s.title, s.content_chars, s.message_count, p.path as project_path, src.name as source
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    JOIN sources src ON p.source_id = src.id
    ORDER BY s.content_chars DESC
    LIMIT 20
  `);

  console.log("\n=== Top 20 Longest Sessions ===\n");
  console.log("Chars        Messages  Source       Project");
  console.log("─────────────────────────────────────────────────────────────");
  for (const row of longest.rows) {
    const proj = row.project_path.split("/").slice(-2).join("/");
    const chars = Number(row.content_chars).toLocaleString().padStart(12);
    console.log(`${chars}    ${String(row.message_count).padStart(6)}  ${row.source.padEnd(12)} ${proj}`);
  }

  // Messages over 8k chars
  const longMessages = await query<{ count: number; max_chars: number; avg_chars: number }>(`
    SELECT
      COUNT(*) as count,
      MAX(LENGTH(content_text)) as max_chars,
      AVG(LENGTH(content_text))::int as avg_chars
    FROM messages
    WHERE LENGTH(content_text) > 8000
  `);

  console.log("\n=== Messages > 8k chars (need summarization) ===\n");
  console.log(`Count: ${longMessages.rows[0].count}`);
  console.log(`Max:   ${Number(longMessages.rows[0].max_chars).toLocaleString()} chars`);
  console.log(`Avg:   ${Number(longMessages.rows[0].avg_chars).toLocaleString()} chars`);

  // Check content_chars population by source
  const bySource = await query<{ name: string; total: number; with_chars: number; without_chars: number }>(`
    SELECT src.name,
           COUNT(*)::int as total,
           COUNT(CASE WHEN s.content_chars > 0 THEN 1 END)::int as with_chars,
           COUNT(CASE WHEN s.content_chars IS NULL OR s.content_chars = 0 THEN 1 END)::int as without_chars
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    JOIN sources src ON p.source_id = src.id
    GROUP BY src.name
  `);

  console.log("\n=== Sessions with content_chars by source ===\n");
  for (const row of bySource.rows) {
    console.log(`${row.name}: ${row.with_chars}/${row.total} have content_chars (${row.without_chars} missing)`);
  }

  await closePool();
}

main().catch(console.error);
