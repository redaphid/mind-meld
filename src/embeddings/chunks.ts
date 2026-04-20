import { config } from "../config.js";
import { query } from "../db/postgres.js";
import { upsertEmbeddings, deleteByIds } from "../db/chroma.js";
import { generateEmbeddings } from "./ollama.js";
import {
  summarizeChunk,
  chunkMessagesWithIndices,
  CHUNK_SIZE_CHARS,
  SHORT_CONVERSATION_CHARS,
} from "./summarize.js";

export interface SessionMessage {
  id: number;
  role: string;
  content_text: string;
}

export interface PersistedChunk {
  id: number;
  chunkIndex: number;
  startMessageId: number;
  endMessageId: number;
  summary: string;
  contentChars: number;
}

const formatForSummary = (m: SessionMessage): string =>
  `[${m.role.toUpperCase()}]: ${m.content_text}`;

// Persist chunk-level summaries + embeddings for a session. Returns the
// persisted chunks so callers can combine their summaries into a session-level
// summary without re-running qwen on every chunk.
//
// Returns null when the session is short enough that chunking would be
// pointless — in that case, the session summary IS the whole thing and there's
// no middle layer to build.
export const persistSessionChunks = async (
  sessionId: number,
  messages: SessionMessage[],
): Promise<PersistedChunk[] | null> => {
  if (messages.length === 0) return null;

  const formatted = messages.map(formatForSummary);
  const combinedChars = formatted.reduce((sum, m) => sum + m.length + 10, 0);

  // Skip short sessions — no meaningful middle layer exists
  if (combinedChars <= SHORT_CONVERSATION_CHARS) return null;

  // Single chunk: the session summary already covers everything, skip middle layer
  if (combinedChars <= CHUNK_SIZE_CHARS) return null;

  const chunks = chunkMessagesWithIndices(formatted, CHUNK_SIZE_CHARS);
  console.log(
    `persistSessionChunks: session ${sessionId} → ${chunks.length} chunks`,
  );

  // Nuke existing chunks for this session (CASCADE drops embedding rows, but
  // we must also drop the Chroma-side entries before the rows disappear).
  const existing = await query<{ id: number }>(
    `SELECT id FROM session_chunks WHERE session_id = $1`,
    [sessionId],
  );
  if (existing.rows.length > 0) {
    const chromaIds = existing.rows.map((r) => `chunk-${r.id}`);
    try {
      await deleteByIds(config.chroma.collections.chunks, chromaIds);
    } catch (e) {
      console.warn(`Chroma delete failed for session ${sessionId} chunks:`, e);
    }
    await query(`DELETE FROM session_chunks WHERE session_id = $1`, [
      sessionId,
    ]);
  }

  const persisted: PersistedChunk[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkText = chunk.messages.join("\n\n---\n\n");
    const startMessageId = messages[chunk.startIndex].id;
    const endMessageId = messages[chunk.endIndex].id;

    let summary: string;
    try {
      console.log(
        `Summarizing chunk ${i + 1}/${chunks.length} for session ${sessionId} (${chunkText.length} chars, messages ${startMessageId}..${endMessageId})...`,
      );
      summary = await summarizeChunk(chunkText, true);
      console.log(`Chunk ${i + 1} → ${summary.length} chars`);
    } catch (e) {
      console.error(
        `persistSessionChunks: chunk ${i + 1}/${chunks.length} failed for session ${sessionId}:`,
        e,
      );
      continue;
    }

    const row = await query<{ id: number }>(
      `INSERT INTO session_chunks
         (session_id, chunk_index, start_message_id, end_message_id, summary, content_chars)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [sessionId, i, startMessageId, endMessageId, summary, chunkText.length],
    );

    const chunkId = row.rows[0].id;
    const chromaId = `chunk-${chunkId}`;

    const [embedding] = await generateEmbeddings([summary.slice(0, 32000)]);
    if (!embedding) {
      console.warn(
        `Embedding generation failed for chunk ${chunkId}; row persisted without vector`,
      );
      persisted.push({
        id: chunkId,
        chunkIndex: i,
        startMessageId,
        endMessageId,
        summary,
        contentChars: chunkText.length,
      });
      continue;
    }

    await upsertEmbeddings(config.chroma.collections.chunks, {
      ids: [chromaId],
      embeddings: [embedding],
      documents: [summary.slice(0, 2000)],
      metadatas: [
        {
          session_id: sessionId.toString(),
          chunk_index: i,
          start_message_id: startMessageId.toString(),
          end_message_id: endMessageId.toString(),
          content_chars: chunkText.length,
          embedded_at: Date.now(),
        },
      ],
    });

    await query(
      `INSERT INTO embeddings
         (session_chunk_id, chroma_collection, chroma_id, embedding_model, dimensions, content_chars_at_embed, summarize_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        chunkId,
        config.chroma.collections.chunks,
        chromaId,
        config.embeddings.model,
        config.embeddings.dimensions,
        chunkText.length,
        config.embeddings.summarizeModel,
      ],
    );

    persisted.push({
      id: chunkId,
      chunkIndex: i,
      startMessageId,
      endMessageId,
      summary,
      contentChars: chunkText.length,
    });
  }

  return persisted;
};
