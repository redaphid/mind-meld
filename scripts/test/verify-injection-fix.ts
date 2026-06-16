// One-shot: re-run the aggregate path against sessions that historically
// threw "Summary too short" and confirm they now exit the pending queue.

import "dotenv/config";
import { query, closePool } from "../../src/db/postgres.js";
import { summarizeConversation } from "../../src/embeddings/summarize.js";

const TARGETS = [209770, 209772];

const main = async () => {
  for (const id of TARGETS) {
    const before = await query<{
      has_embedding: boolean;
      content_chars: number;
      summary_head: string | null;
    }>(
      `SELECT (e.id IS NOT NULL) AS has_embedding, s.content_chars,
              LEFT(s.summary, 60) AS summary_head
       FROM sessions s
       LEFT JOIN embeddings e
         ON e.chroma_collection = 'convo-sessions'
        AND e.chroma_id = 'session-' || s.id::text
       WHERE s.id = $1`,
      [id],
    );
    console.log(`session ${id} BEFORE:`, before.rows[0]);

    const messages = await query<{ role: string; content_text: string }>(
      `SELECT role, content_text FROM messages
       WHERE session_id = $1 AND content_text IS NOT NULL AND LENGTH(content_text) > 0
       ORDER BY sequence_num`,
      [id],
    );
    const formatted = messages.rows.map(
      (m) => `[${m.role.toUpperCase()}]: ${m.content_text}`,
    );

    try {
      const summary = await summarizeConversation(formatted);
      console.log(`session ${id}: summary OK (${summary.length} chars)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`session ${id}: summarizer threw → ${msg.slice(0, 120)}`);
    }
  }
};

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closePool());
