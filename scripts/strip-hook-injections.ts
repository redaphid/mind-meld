// Strip hook-injected `<system-reminder>` blocks from existing messages.
// Scope: only invalidate downstream embeddings when stripping removes ≥10%
// of the original content (small surgical edits keep their embedding).
//
// Run against live postgres/chroma:
//   POSTGRES_HOST=localhost POSTGRES_PORT=5433 \
//   CHROMA_HOST=localhost CHROMA_PORT=8001 \
//   pnpm tsx scripts/strip-hook-injections.ts

import { query, closePool } from "../src/db/postgres.js";
import { deleteByIds } from "../src/db/chroma.js";
import { config } from "../src/config.js";

const HOOK_INJECTION_PATTERN =
  /<system-reminder>[\s\S]*?(?:UserPromptSubmit hook additional context|SessionStart hook additional context|ACCESSIBILITY ACCOMMODATION|task-notification)[\s\S]*?<\/system-reminder>/g;

const INVALIDATE_THRESHOLD = 0.1; // ≥10% stripped ⇒ invalidate embedding

const BATCH = 500;

interface Row {
  id: number;
  session_id: number;
  content_text: string;
}

const pickBatch = async (afterId: number) =>
  query<Row>(
    `SELECT id, session_id, content_text FROM messages
     WHERE id > $1
       AND content_text LIKE '%<system-reminder>%'
     ORDER BY id
     LIMIT $2`,
    [afterId, BATCH],
  );

const main = async () => {
  let lastId = 0;
  let touched = 0;
  let invalidated = 0;
  let emptied = 0;
  const sessionsToReaggregate = new Set<number>();
  const messageChromaIdsToDelete: string[] = [];

  while (true) {
    const { rows } = await pickBatch(lastId);
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      const stripped = row.content_text.replace(HOOK_INJECTION_PATTERN, "").trim();
      if (stripped === row.content_text.trim()) continue;

      const removedFrac = 1 - stripped.length / row.content_text.length;
      touched++;

      if (stripped.length === 0) {
        emptied++;
        await query(
          `UPDATE messages SET content_text = '' WHERE id = $1`,
          [row.id],
        );
        await query(
          `INSERT INTO embeddings (message_id, chroma_collection, chroma_id, embedding_model,
             dimensions, content_chars_at_embed, failure_reason, failure_detail, retry_count, updated_at)
           VALUES ($1, 'UNEMBEDDABLE', 'unembeddable-' || $1, 'none', 0, 0, 'noise', 'hook-injection-only', 0, NOW())
           ON CONFLICT (message_id, chroma_collection)
           DO UPDATE SET failure_reason = 'noise', failure_detail = 'hook-injection-only', updated_at = NOW()`,
          [row.id],
        );
        messageChromaIdsToDelete.push(`msg-${row.id}`);
        sessionsToReaggregate.add(row.session_id);
        continue;
      }

      await query(
        `UPDATE messages SET content_text = $1 WHERE id = $2`,
        [stripped, row.id],
      );

      if (removedFrac >= INVALIDATE_THRESHOLD) {
        invalidated++;
        await query(
          `DELETE FROM embeddings WHERE message_id = $1 AND chroma_collection = $2`,
          [row.id, config.chroma.collections.messages],
        );
        messageChromaIdsToDelete.push(`msg-${row.id}`);
        sessionsToReaggregate.add(row.session_id);
      }
    }

    if (messageChromaIdsToDelete.length >= 200) {
      await deleteByIds(config.chroma.collections.messages, messageChromaIdsToDelete);
      messageChromaIdsToDelete.length = 0;
    }

    console.log(
      `lastId=${lastId} touched=${touched} invalidated=${invalidated} emptied=${emptied} sessions=${sessionsToReaggregate.size}`,
    );
  }

  if (messageChromaIdsToDelete.length > 0) {
    await deleteByIds(config.chroma.collections.messages, messageChromaIdsToDelete);
  }

  // Invalidate session-level embeddings and chunks for affected sessions so
  // the next aggregate pass re-summarizes from clean content.
  const sessionIds = [...sessionsToReaggregate];
  for (let i = 0; i < sessionIds.length; i += 500) {
    const slice = sessionIds.slice(i, i + 500);
    await query(
      `DELETE FROM embeddings
       WHERE chroma_collection = $1
         AND chroma_id = ANY($2::text[])`,
      [config.chroma.collections.sessions, slice.map((id) => `session-${id}`)],
    );
    await deleteByIds(
      config.chroma.collections.sessions,
      slice.map((id) => `session-${id}`),
    );
    await query(
      `DELETE FROM session_chunks WHERE session_id = ANY($1::bigint[])`,
      [slice],
    );
  }

  console.log(
    `\ndone. touched=${touched} invalidated=${invalidated} emptied=${emptied} sessions_reset=${sessionsToReaggregate.size}`,
  );
};

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closePool());
