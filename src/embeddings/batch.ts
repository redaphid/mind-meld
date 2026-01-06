import { config } from '../config.js';
import { query, queries } from '../db/postgres.js';
import { addEmbeddings, upsertEmbeddings, getEmbeddingMetadata, getCollection } from '../db/chroma.js';
import { generateEmbeddings, ensureEmbeddingModel } from './ollama.js';
import { summarizeConversation, ensureSummarizeModel } from './summarize.js';

export interface BatchEmbeddingStats {
  processed: number;
  skipped: number;
  errors: number;
}

interface MessageToEmbed {
  id: number;
  session_id: number;
  content_text: string;
  role: string;
  timestamp: Date;
  project_path: string;
  source_name: string;
  model: string | null;
}

// Mark a message as un-embeddable (Ollama bug workaround)
export async function markUnembeddable(messageId: number): Promise<void> {
  await query(
    `INSERT INTO embeddings (message_id, chroma_collection, chroma_id, embedding_model, dimensions, content_chars_at_embed)
     VALUES ($1, 'UNEMBEDDABLE', 'unembeddable-' || $2, 'none', 0, 0)
     ON CONFLICT (message_id, chroma_collection) DO NOTHING`,
    [messageId, messageId.toString()]
  )
  console.log(`  ⚠️  Marked message ${messageId} as un-embeddable`)
}

// Get candidate messages for embedding - only those not yet embedded and not marked as un-embeddable
async function getMessagesToEmbed(limit: number): Promise<MessageToEmbed[]> {
  const result = await query<MessageToEmbed>(
    `SELECT m.id, m.session_id, m.content_text, m.role, m.timestamp,
            p.path as project_path, src.name as source_name, m.model
     FROM messages m
     JOIN sessions s ON m.session_id = s.id
     JOIN projects p ON s.project_id = p.id
     JOIN sources src ON p.source_id = src.id
     LEFT JOIN embeddings e ON e.message_id = m.id AND e.chroma_collection = 'convo-messages'
     LEFT JOIN embeddings skip ON skip.message_id = m.id AND skip.chroma_collection = 'UNEMBEDDABLE'
     WHERE m.content_text IS NOT NULL
       AND LENGTH(m.content_text) > 10
       AND e.id IS NULL
       AND skip.id IS NULL
     ORDER BY m.id
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

// Generate embeddings for pending messages
// Checks Chroma directly to determine what needs embedding (missing or outdated char count)
export async function generatePendingEmbeddings(): Promise<BatchEmbeddingStats> {
  const stats: BatchEmbeddingStats = {
    processed: 0,
    skipped: 0,
    errors: 0,
  };

  // Ensure models are available
  await ensureEmbeddingModel();
  await ensureSummarizeModel();

  const batchSize = config.embeddings.batchSize;
  let hasMore = true;
  let totalProcessed = 0;

  while (hasMore) {
    // Query only returns messages without embeddings in Postgres
    const messagesToEmbed = await getMessagesToEmbed(batchSize);

    if (messagesToEmbed.length === 0) {
      hasMore = false;
      break;
    }

    totalProcessed += messagesToEmbed.length;
    console.log(`Batch: ${messagesToEmbed.length} messages need embedding (${totalProcessed} total)...`);

    try {
      // Prepare texts for embedding - summarize if too long for embedding context
      const MAX_EMBED_CHARS = 8000;
      const texts: string[] = [];
      for (const m of messagesToEmbed) {
        if (m.content_text.length > MAX_EMBED_CHARS) {
          // Summarize long messages to preserve semantic content
          const summary = await summarizeConversation([m.content_text]);
          texts.push(summary);
        } else {
          texts.push(m.content_text);
        }
      }
      const embeddings = await generateEmbeddings(texts);

      // Separate successful embeddings from failed ones (null)
      const successful: Array<{ index: number; embedding: number[] }> = [];
      const failed: number[] = [];

      for (let i = 0; i < embeddings.length; i++) {
        if (embeddings[i] === null) {
          failed.push(i);
        } else {
          successful.push({ index: i, embedding: embeddings[i]! });
        }
      }

      // Mark failed messages as un-embeddable
      for (const idx of failed) {
        await markUnembeddable(messagesToEmbed[idx].id);
        stats.skipped++;
      }

      // Only process successful embeddings
      if (successful.length > 0) {
        const chromaData = {
          ids: successful.map((s) => `msg-${messagesToEmbed[s.index].id}`),
          embeddings: successful.map((s) => s.embedding),
          documents: successful.map((s) => texts[s.index]),
          metadatas: successful.map((s) => ({
            source: messagesToEmbed[s.index].source_name,
            project_path: messagesToEmbed[s.index].project_path,
            session_id: messagesToEmbed[s.index].session_id.toString(),
            message_id: messagesToEmbed[s.index].id.toString(),
            role: messagesToEmbed[s.index].role,
            timestamp: messagesToEmbed[s.index].timestamp.getTime(),
            model: messagesToEmbed[s.index].model ?? '',
            has_tool_use: messagesToEmbed[s.index].role === 'tool',
            token_count: messagesToEmbed[s.index].content_text.length,
          })),
        };

        // Upsert to Chroma (update if exists, insert if not)
        await upsertEmbeddings(config.chroma.collections.messages, chromaData);

        // Upsert to PostgreSQL
        for (const s of successful) {
          await query(
            `INSERT INTO embeddings (message_id, chroma_collection, chroma_id, embedding_model, dimensions, content_chars_at_embed)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (message_id, chroma_collection)
             DO UPDATE SET content_chars_at_embed = $6, embedding_model = $4`,
            [
              messagesToEmbed[s.index].id,
              config.chroma.collections.messages,
              `msg-${messagesToEmbed[s.index].id}`,
              config.embeddings.model,
              config.embeddings.dimensions,
              messagesToEmbed[s.index].content_text.length,
            ]
          );
        }

        stats.processed += successful.length;
      }

      if (failed.length > 0) {
        console.log(`Marked ${failed.length} messages as un-embeddable`);
      }
      console.log(`Embedded ${stats.processed} messages total`);
    } catch (e) {
      console.error('Batch embedding failed:', e);
      stats.errors++;
    }

    // Small delay to avoid overwhelming Ollama
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return stats;
}

// Update session-level embeddings with summarization for long conversations
// Now also re-embeds sessions where content_chars has grown
export async function updateAggregateEmbeddings(): Promise<{ sessionsUpdated: number; sessionsReembedded: number }> {
  // Ensure summarization model is available
  await ensureSummarizeModel();

  // Get sessions that need embedding:
  // 1. Sessions with no embedding yet
  // 2. Sessions where content_chars > content_chars_at_embed (content has grown)
  const sessions = await query<{
    id: number;
    external_id: string;
    title: string;
    project_path: string;
    source_name: string;
    message_count: number;
    total_tokens: number;
    content_chars: number;
    started_at: Date | null;
    existing_content_chars: number | null;
  }>(
    `SELECT s.id, s.external_id, s.title, p.path as project_path, src.name as source_name,
            s.message_count, s.total_input_tokens + s.total_output_tokens as total_tokens,
            s.content_chars, s.started_at,
            e.content_chars_at_embed as existing_content_chars
     FROM sessions s
     JOIN projects p ON s.project_id = p.id
     JOIN sources src ON p.source_id = src.id
     LEFT JOIN embeddings e ON e.chroma_collection = $1 AND e.chroma_id = 'session-' || s.id::text
     WHERE s.message_count > 0
       AND s.title != 'Warmup'  -- Exclude noise sessions
       AND (
         e.id IS NULL  -- No embedding exists
         OR s.content_chars > COALESCE(e.content_chars_at_embed, 0)  -- Content has grown
         OR COALESCE(s.content_chars, 0) = 0  -- content_chars not calculated yet
       )
     LIMIT 100`,
    [config.chroma.collections.sessions]
  );

  if (sessions.rows.length === 0) {
    return { sessionsUpdated: 0, sessionsReembedded: 0 };
  }

  let newEmbeddings = 0;
  let reembeddings = 0;

  console.log(`Processing ${sessions.rows.length} session embeddings...`);

  for (const session of sessions.rows) {
    const isReembed = session.existing_content_chars !== null;

    try {
      // Also verify Chroma has the embedding with correct content_chars
      const chromaMetadata = await getEmbeddingMetadata(
        config.chroma.collections.sessions,
        `session-${session.id}`
      );

      // Skip if Chroma already has this exact content_chars
      if (chromaMetadata) {
        const chromaContentChars = chromaMetadata.content_chars as number | undefined;
        if (chromaContentChars && chromaContentChars >= session.content_chars) {
          console.log(`  Session ${session.id}: Chroma up-to-date (${chromaContentChars} chars)`);
          continue;
        }
      }

      // Get ALL message content for this session
      const messages = await query<{ content_text: string; role: string }>(
        `SELECT content_text, role FROM messages
         WHERE session_id = $1 AND content_text IS NOT NULL AND LENGTH(content_text) > 0
         ORDER BY sequence_num`,
        [session.id]
      );

      if (messages.rows.length === 0) continue;

      // Format messages with role context
      const formattedMessages = messages.rows.map(
        (m) => `[${m.role.toUpperCase()}]: ${m.content_text}`
      );

      // Calculate actual content chars
      const actualContentChars = formattedMessages.reduce((sum, m) => sum + m.length, 0);

      // Summarize if needed (handles long conversations automatically)
      const textForEmbedding = await summarizeConversation(formattedMessages)
      const wasSummarized = textForEmbedding.length < formattedMessages.join('').length

      // Generate embedding from summary or full text
      const embeddings = await generateEmbeddings([textForEmbedding.slice(0, 8000)])

      // Skip session if embedding failed
      if (embeddings[0] === null) {
        console.log(`⚠️  Session ${session.id} could not be embedded - skipping`)
        continue
      }

      // Upsert to Chroma sessions collection (update if exists)
      await upsertEmbeddings(config.chroma.collections.sessions, {
        ids: [`session-${session.id}`],
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
      })

      // Store summary in Postgres for FTS (always update - summary improves over time)
      await query(
        `UPDATE sessions SET summary = $1, content_chars = $2 WHERE id = $3`,
        [textForEmbedding, actualContentChars, session.id]
      )

      // Record/update in PostgreSQL with content_chars_at_embed
      await query(
        `INSERT INTO embeddings (message_id, chroma_collection, chroma_id, embedding_model, dimensions, content_chars_at_embed)
         SELECT m.id, $1, $2, $3, $4, $5
         FROM messages m WHERE m.session_id = $6 LIMIT 1
         ON CONFLICT (message_id, chroma_collection)
         DO UPDATE SET content_chars_at_embed = $5`,
        [
          config.chroma.collections.sessions,
          `session-${session.id}`,
          config.embeddings.model,
          config.embeddings.dimensions,
          actualContentChars,
          session.id,
        ]
      );

      if (isReembed) {
        reembeddings++;
        console.log(`Re-embedded session ${session.id} (${session.existing_content_chars} → ${actualContentChars} chars)`);
      } else {
        newEmbeddings++;
        console.log(`Embedded session ${session.id} (${session.message_count} messages, ${actualContentChars} chars)`);
      }
    } catch (e) {
      console.error(`Failed to update session ${session.id} embedding:`, e);
    }
  }

  return { sessionsUpdated: newEmbeddings, sessionsReembedded: reembeddings };
}
