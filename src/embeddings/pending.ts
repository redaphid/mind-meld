import { config } from "../config.js";
import { notWarmup } from "../mcp/title.js";

// ONE definition of "work the embedder will actually pick up".
//
// This file exists because there used to be two, and they disagreed by five
// figures. `/status` and `/api/throughput` counted every message with more than
// 10 characters and no `convo-messages` row, while the embedder additionally
// skipped tool messages, deleted and automated sessions, and anything carrying
// an UNEMBEDDABLE marker. Everything in that gap was counted forever and worked
// never: on 2026-08-03 the dashboard advertised 32,339 pending (30,961 of them
// noise-marked, 1,376 in deleted sessions, 2 tool messages) and an ETA in
// October 2027, against zero real work. The queue was idle because it was
// finished, and every number on the screen said otherwise.
//
// So the predicate is written once, here, and both the selector and the
// counters import it. A number the UI shows must be the number the worker acts
// on; the only way to guarantee that is to stop restating it.

const healingParams = () => [config.healing.retryLimit, config.healing.cooldownDays];

// The message-side FROM/WHERE, minus the SELECT list, so the same rows can be
// selected for embedding or merely counted. `firstParam` is where this
// fragment's own placeholders begin, letting a caller reserve $1 for a LIMIT.
//
// The UNEMBEDDABLE join is deliberately not a plain "has a marker" test: a
// NaN failure that is still inside its retry budget and past its cooldown is
// healable, so it does NOT suppress the row. Those messages are real pending
// work and must keep counting as such.
export const embeddableMessages = (
  firstParam = 1,
  maxChars?: number,
): { sql: string; params: number[] } => {
  const retryLimit = `$${firstParam}`;
  const cooldownDays = `$${firstParam + 1}`;
  // A number from config, not user input — but coerced so it can never be
  // anything but a number in the SQL text.
  const charFilter =
    maxChars === undefined
      ? ""
      : `AND LENGTH(m.content_text) <= ${Number(maxChars)}`;

  return {
    sql: `FROM messages m
     JOIN sessions s ON m.session_id = s.id
     JOIN projects p ON s.project_id = p.id
     JOIN sources src ON p.source_id = src.id
     LEFT JOIN embeddings e ON e.message_id = m.id AND e.chroma_collection = 'convo-messages'
     LEFT JOIN embeddings skip ON skip.message_id = m.id
       AND skip.chroma_collection = 'UNEMBEDDABLE'
       AND NOT (
         skip.failure_reason = 'nan'
         AND skip.retry_count < ${retryLimit}
         AND skip.updated_at < NOW() - make_interval(days => ${cooldownDays})
       )
     WHERE m.content_text IS NOT NULL
       AND LENGTH(m.content_text) > 10
       AND m.role != 'tool'
       AND s.deleted_at IS NULL
       AND s.is_automated = false
       AND e.id IS NULL
       AND skip.id IS NULL
       ${charFilter}`,
    params: healingParams(),
  };
};

// The session-side equivalent, shared by `updateAggregateEmbeddings` and the
// pending-sessions counter.
//
// Still-active sessions (ended within 30 minutes) are excluded on both sides on
// purpose: re-summarizing a live conversation from scratch as it grows is waste,
// so the embedder defers them. They are not queued work yet, and counting them
// as such is what kept this number from ever reaching zero.
export const embeddableSessions = (collectionParam: string): string =>
  `FROM sessions s
     JOIN projects p ON s.project_id = p.id
     JOIN sources src ON p.source_id = src.id
     LEFT JOIN embeddings e ON e.chroma_collection = ${collectionParam} AND e.chroma_id = 'session-' || s.id::text
     WHERE s.message_count > 0
       AND ${notWarmup("s")}
       AND s.deleted_at IS NULL
       AND s.is_automated = false
       AND (s.ended_at IS NULL OR s.ended_at < NOW() - INTERVAL '30 minutes')
       AND (
         e.id IS NULL
         OR s.content_chars > COALESCE(e.content_chars_at_embed, 0)
         OR COALESCE(s.content_chars, 0) = 0
       )`;

// Counters for the dashboard. These are the numbers /status and
// /api/throughput report, and they are the same rows the workers pull.
export const pendingMessagesCount = () => {
  const { sql, params } = embeddableMessages(1);
  return { sql: `SELECT COUNT(*) as count ${sql}`, params };
};

export const pendingSessionsCount = (collection: string) => ({
  sql: `SELECT COUNT(*) as count ${embeddableSessions("$1")}`,
  params: [collection],
});
