// Reproduce a single chunk's summarization in isolation so we can see what
// qwen actually produced. Use when a chunk comes back suspiciously long
// (e.g. ~30k chars, hitting num_predict).
//
// Usage: POSTGRES_HOST=localhost POSTGRES_PORT=5433 \
//        OLLAMA_URL=http://soul.local:11434 \
//        pnpm tsx scripts/debug-chunk.ts <sessionId> <chunkIndex>

import { query, closePool } from "../src/db/postgres.js";
import {
  summarizeChunk,
  chunkMessagesWithIndices,
  CHUNK_SIZE_CHARS,
} from "../src/embeddings/summarize.js";

const [sessionIdArg, chunkIndexArg] = process.argv.slice(2);
const sessionId = Number(sessionIdArg);
const chunkIndex = Number(chunkIndexArg);

if (!Number.isFinite(sessionId) || !Number.isFinite(chunkIndex)) {
  console.error("Usage: pnpm tsx scripts/debug-chunk.ts <sessionId> <chunkIndex>");
  process.exit(1);
}

const main = async () => {
  const messages = await query<{ id: number; role: string; content_text: string }>(
    `SELECT id, role, content_text FROM messages
     WHERE session_id = $1 AND content_text IS NOT NULL AND LENGTH(content_text) > 0
     ORDER BY sequence_num`,
    [sessionId],
  );

  const formatted = messages.rows.map(
    (m) => `[${m.role.toUpperCase()}]: ${m.content_text}`,
  );
  const chunks = chunkMessagesWithIndices(formatted, CHUNK_SIZE_CHARS);

  console.log(`Session ${sessionId}: ${messages.rows.length} messages, ${chunks.length} chunks`);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const chars = c.messages.reduce((s, m) => s + m.length + 10, 0);
    const startMsgId = messages.rows[c.startIndex].id;
    const endMsgId = messages.rows[c.endIndex].id;
    const marker = i === chunkIndex ? " ← target" : "";
    console.log(
      `  chunk ${i}: ${c.messages.length} messages, ${chars} chars, msg ${startMsgId}..${endMsgId}${marker}`,
    );
  }

  const target = chunks[chunkIndex];
  if (!target) {
    console.error(`chunk index ${chunkIndex} out of range`);
    process.exit(1);
  }

  const chunkText = target.messages.join("\n\n---\n\n");
  console.log(`\n=== Target chunk input (${chunkText.length} chars) ===`);
  console.log("First 500 chars:", chunkText.slice(0, 500));
  console.log("\nLast 500 chars:", chunkText.slice(-500));
  console.log(`\nRole distribution in chunk:`);
  const roleCounts: Record<string, number> = {};
  for (const m of target.messages) {
    const role = m.match(/^\[([A-Z]+)\]/)?.[1] ?? "UNKNOWN";
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
  }
  console.log(roleCounts);

  console.log("\n=== Running summarizeChunk ===");
  const start = Date.now();
  const summary = await summarizeChunk(chunkText, true);
  const elapsed = Math.round((Date.now() - start) / 1000);

  console.log(`\nSummary (${summary.length} chars, ${elapsed}s):`);
  console.log("---");
  console.log(summary);
  console.log("---");
  console.log(`\nCompression: ${((summary.length / chunkText.length) * 100).toFixed(1)}%`);
  console.log(`Summary estimated tokens: ~${Math.round(summary.length / 4)}`);
};

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closePool());
