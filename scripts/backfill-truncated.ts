// Re-embed session and chunk vectors that were built from silently truncated text.
//
// Before ba24fe3 every embed call ran with ollama's default truncate:true, so any
// summary over bge-m3's 8192-token window was clipped to a prefix and stored as if
// it were whole. Those rows are recorded as successfully embedded, so nothing in the
// normal pipeline will ever revisit them.
//
// The summaries themselves are fine — only the vectors are wrong. So this keeps each
// existing summary and re-embeds it through the shrink path, leaving Chroma documents
// and metadata untouched.
//
//   pnpm exec tsx scripts/backfill-truncated.ts --dry-run
//   pnpm exec tsx scripts/backfill-truncated.ts
import { query } from "../src/db/postgres.js";
import { config } from "../src/config.js";
import {
  getOllamaClient,
  generateEmbeddings,
  isOversizeEmbedError,
} from "../src/embeddings/ollama.js";
import { getCollection } from "../src/db/chroma.js";

// Shortest text observed clipped anywhere was 4,908 chars. 4,000 buys margin without
// probing the ~24k summaries that are obviously safe.
const MIN_CHARS = 4000;
const DRY_RUN = process.argv.includes("--dry-run");

interface Tier {
  name: string;
  collection: string;
  chromaId: (id: number) => string;
  sql: string;
}

const TIERS: Tier[] = [
  {
    name: "sessions",
    collection: config.chroma.collections.sessions,
    chromaId: (id) => `session-${id}`,
    sql: `SELECT s.id, s.summary
          FROM sessions s
          JOIN embeddings e ON e.chroma_id = 'session-' || s.id::text
            AND e.chroma_collection = $1
          WHERE s.summary IS NOT NULL AND length(s.summary) > $2
          ORDER BY length(s.summary) DESC`,
  },
  {
    name: "chunks",
    collection: config.chroma.collections.chunks,
    chromaId: (id) => `chunk-${id}`,
    sql: `SELECT c.id, c.summary
          FROM session_chunks c
          JOIN embeddings e ON e.session_chunk_id = c.id
            AND e.chroma_collection = $1
          WHERE c.summary IS NOT NULL AND length(c.summary) > $2
          ORDER BY length(c.summary) DESC`,
  },
];

// Would ollama have silently clipped this text? truncate:false turns the clip it
// used to perform quietly into a 400 we can count.
const wasClipped = async (text: string) => {
  try {
    await getOllamaClient().embed({
      model: config.embeddings.model,
      input: [text],
      truncate: false,
      keep_alive: "30m",
    });
    return false;
  } catch (error: any) {
    if (isOversizeEmbedError(error)) return true;
    throw error;
  }
};

const backfillTier = async (tier: Tier) => {
  const rows = await query<{ id: number; summary: string }>(tier.sql, [
    tier.collection,
    MIN_CHARS,
  ]);
  console.log(
    `\n=== ${tier.name}: probing ${rows.rows.length} rows over ${MIN_CHARS} chars ===`,
  );

  const collection = await getCollection(tier.collection);
  let probed = 0;
  let clipped = 0;
  let repaired = 0;
  let unembeddable = 0;
  let missing = 0;

  for (const row of rows.rows) {
    probed++;
    if (probed % 250 === 0) {
      console.log(
        `  …${probed}/${rows.rows.length} probed, ${clipped} clipped`,
      );
    }
    if (!(await wasClipped(row.summary))) continue;

    clipped++;
    const chromaId = tier.chromaId(row.id);
    if (DRY_RUN) {
      console.log(`  [dry-run] ${chromaId} (${row.summary.length} chars)`);
      continue;
    }

    const existing = await collection.get({
      ids: [chromaId],
      include: ["metadatas", "documents"],
    });
    if (existing.ids.length === 0) {
      console.warn(`  ${chromaId} absent from Chroma; skipping`);
      missing++;
      continue;
    }

    const [embedding] = await generateEmbeddings([row.summary]);
    if (!embedding) {
      console.warn(`  ${chromaId} un-embeddable even after rewrites`);
      unembeddable++;
      continue;
    }

    // Same id, same document, same metadata — only the vector changes.
    await collection.upsert({
      ids: [chromaId],
      embeddings: [embedding],
      documents: [existing.documents[0] ?? row.summary],
      metadatas: [existing.metadatas[0] ?? {}],
    });
    repaired++;
    console.log(
      `  ✅ ${chromaId} re-embedded (${row.summary.length} chars) — ${repaired}/${clipped}`,
    );
  }

  return { tier: tier.name, probed, clipped, repaired, unembeddable, missing };
};

const results = [];
for (const tier of TIERS) {
  results.push(await backfillTier(tier));
}

console.log(
  `\n=== summary${DRY_RUN ? " (dry run — nothing written)" : ""} ===`,
);
console.table(results);
process.exit(0);
