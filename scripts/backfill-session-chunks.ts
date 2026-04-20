// Generate chunk-level summaries for existing sessions that were summarized
// before the middle-tier feature existed. Skips sessions that already have
// chunks (idempotent) and sessions short enough to not need one.
//
// Run against live postgres/chroma/ollama:
//   POSTGRES_HOST=localhost POSTGRES_PORT=5433 \
//   CHROMA_HOST=localhost CHROMA_PORT=8001 \
//   OLLAMA_URL=http://soul.local:11434 \
//   pnpm tsx scripts/backfill-session-chunks.ts

import { query, closePool } from "../src/db/postgres.js";
import { persistSessionChunks, SessionMessage } from "../src/embeddings/chunks.js";
import { ensureSummarizeModel, CHUNK_SIZE_CHARS } from "../src/embeddings/summarize.js";
import { ensureEmbeddingModel } from "../src/embeddings/ollama.js";

const BATCH_LIMIT = 50;

const pickSessions = async () =>
  query<{ id: number; content_chars: number; message_count: number }>(
    `SELECT s.id, s.content_chars, s.message_count
     FROM sessions s
     LEFT JOIN session_chunks sc ON sc.session_id = s.id
     WHERE s.message_count > 0
       AND s.content_chars > $1
       AND sc.id IS NULL
     GROUP BY s.id
     ORDER BY s.id
     LIMIT $2`,
    [CHUNK_SIZE_CHARS, BATCH_LIMIT],
  );

const loadMessages = async (sessionId: number) =>
  query<SessionMessage>(
    `SELECT id, role, content_text FROM messages
     WHERE session_id = $1
       AND content_text IS NOT NULL
       AND LENGTH(content_text) > 0
     ORDER BY sequence_num`,
    [sessionId],
  );

const main = async () => {
  await ensureSummarizeModel();
  await ensureEmbeddingModel();

  let totalSessions = 0;
  let totalChunks = 0;

  while (true) {
    const sessions = await pickSessions();
    if (sessions.rows.length === 0) {
      console.log(
        `done. ${totalSessions} sessions backfilled, ${totalChunks} chunks generated.`,
      );
      return;
    }

    for (const session of sessions.rows) {
      console.log(
        `\nSession ${session.id}: ${session.message_count} messages, ${session.content_chars} chars`,
      );
      const messages = await loadMessages(session.id);
      try {
        const persisted = await persistSessionChunks(session.id, messages.rows);
        if (persisted === null) {
          console.log(`  skipped (short session)`);
          continue;
        }
        totalSessions++;
        totalChunks += persisted.length;
        console.log(
          `  ✓ ${persisted.length} chunks (running total: ${totalSessions} sessions / ${totalChunks} chunks)`,
        );
      } catch (e) {
        console.error(`  ✗ failed:`, e);
      }
    }
  }
};

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closePool());
