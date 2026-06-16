#!/usr/bin/env tsx
// Summarize and embed one session immediately, bypassing the smallest-first queue.
// Usage: tsx scripts/summarize-session.ts <sessionId>
import 'dotenv/config';
import assert from 'node:assert';
import { config } from '../src/config.js';
import { query, closePool } from '../src/db/postgres.js';
import { upsertEmbeddings } from '../src/db/chroma.js';
import { generateEmbeddings } from '../src/embeddings/ollama.js';
import { summarizeConversation, combineSummaries, ensureSummarizeModel } from '../src/embeddings/summarize.js';
import { persistSessionChunks, type SessionMessage } from '../src/embeddings/chunks.js';

const sessionId = Number(process.argv[2]);
assert(Number.isInteger(sessionId) && sessionId > 0, new Error(`Usage: tsx scripts/summarize-session.ts <sessionId>`));

await ensureSummarizeModel();

const sessions = await query<{
  id: number;
  external_id: string;
  title: string;
  project_path: string;
  source_name: string;
  message_count: number;
  total_tokens: number;
  started_at: Date | null;
}>(
  `SELECT s.id, s.external_id, s.title, p.path as project_path, src.name as source_name,
          s.message_count, s.total_input_tokens + s.total_output_tokens as total_tokens, s.started_at
   FROM sessions s
   JOIN projects p ON s.project_id = p.id
   JOIN sources src ON p.source_id = src.id
   WHERE s.id = $1`,
  [sessionId],
);
const session = sessions.rows[0];
assert(session, new Error(`Session ${sessionId} not found`));

const messages = await query<SessionMessage>(
  `SELECT id, content_text, role FROM messages
   WHERE session_id = $1 AND content_text IS NOT NULL AND LENGTH(content_text) > 0
   ORDER BY sequence_num`,
  [sessionId],
);
assert(messages.rows.length > 0, new Error(`Session ${sessionId} has no embeddable content`));

const formattedMessages = messages.rows.map((m) => `[${m.role.toUpperCase()}]: ${m.content_text}`);
const actualContentChars = formattedMessages.reduce((sum, m) => sum + m.length, 0);
console.error(`Session ${sessionId}: ${messages.rows.length} messages, ${actualContentChars} chars`);

const chunks = await persistSessionChunks(sessionId, messages.rows);
const textForEmbedding = chunks
  ? await combineSummaries(chunks.map((c) => c.summary))
  : await summarizeConversation(formattedMessages);
const wasSummarized = textForEmbedding.length < formattedMessages.join('').length;

const embeddings = await generateEmbeddings([textForEmbedding.slice(0, 32000)]);
assert(embeddings[0], new Error('Embedding generation failed'));

await upsertEmbeddings(config.chroma.collections.sessions, {
  ids: [`session-${sessionId}`],
  embeddings: [embeddings[0]],
  documents: [textForEmbedding.slice(0, 2000)],
  metadatas: [
    {
      source: session.source_name,
      project_path: session.project_path,
      session_id: session.external_id,
      title: session.title ?? '',
      started_at: session.started_at?.getTime() ?? Date.now(),
      message_count: session.message_count,
      total_tokens: session.total_tokens,
      content_chars: actualContentChars,
      was_summarized: wasSummarized,
      embedded_at: Date.now(),
    },
  ],
});

await query(`UPDATE sessions SET summary = $1, content_chars = $2 WHERE id = $3`, [
  textForEmbedding,
  actualContentChars,
  sessionId,
]);

await query(
  `INSERT INTO embeddings (message_id, chroma_collection, chroma_id, embedding_model, dimensions, content_chars_at_embed)
   SELECT MIN(m.id), $1, $2, $3, $4, $5
   FROM messages m WHERE m.session_id = $6
   ON CONFLICT (message_id, chroma_collection)
   DO UPDATE SET content_chars_at_embed = $5`,
  [
    config.chroma.collections.sessions,
    `session-${sessionId}`,
    config.embeddings.model,
    config.embeddings.dimensions,
    actualContentChars,
    sessionId,
  ],
);

console.log(textForEmbedding);
await closePool();
