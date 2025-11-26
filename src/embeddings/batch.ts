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

// Get candidate messages for embedding (paginated by offset)
async function getMessagesToEmbed(limit: number, offset: number): Promise<MessageToEmbed[]> {
  const result = await query<MessageToEmbed>(
    `SELECT m.id, m.session_id, m.content_text, m.role, m.timestamp,
            p.path as project_path, src.name as source_name, m.model
     FROM messages m
     JOIN sessions s ON m.session_id = s.id
     JOIN projects p ON s.project_id = p.id
     JOIN sources src ON p.source_id = src.id
     WHERE m.content_text IS NOT NULL
       AND LENGTH(m.content_text) > 10
     ORDER BY m.id
     LIMIT $1 OFFSET $2`,
    [limit, offset]
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
  const collection = await getCollection(config.chroma.collections.messages);
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const messages = await getMessagesToEmbed(batchSize, offset);
    offset += messages.length;

    if (messages.length === 0) {
      hasMore = false;
      break;
    }

    // Check Chroma to see which messages need embedding
    const chromaIds = messages.map((m) => `msg-${m.id}`);
    let chromaResult: { ids: string[]; metadatas: (Record<string, unknown> | null)[] | null };

    try {
      chromaResult = await collection.get({
        ids: chromaIds,
        include: ['metadatas']
      });
    } catch (e) {
      console.error('Failed to check Chroma:', e);
      stats.errors++;
      continue;
    }

    // Build a map of what Chroma has
    const chromaMap = new Map<string, { token_count?: number }>();
    for (let i = 0; i < chromaResult.ids.length; i++) {
      const metadata = chromaResult.metadatas?.[i];
      chromaMap.set(chromaResult.ids[i], {
        token_count: metadata?.token_count as number | undefined,
      });
    }

    // Filter to messages that need embedding:
    // - Not in Chroma at all
    // - Or token_count doesn't match content length
    const messagesToEmbed = messages.filter((m) => {
      const chromaId = `msg-${m.id}`;
      const existing = chromaMap.get(chromaId);
      if (!existing) return true; // Not in Chroma
      if (existing.token_count !== m.content_text.length) return true; // Char count mismatch
      return false;
    });

    if (messagesToEmbed.length === 0) {
      stats.skipped += messages.length;
      if (offset % 5000 === 0) {
        console.log(`Checked ${offset} messages, ${stats.skipped} up-to-date, ${stats.processed} embedded...`);
      }
      continue;
    }

    console.log(`Batch ${offset}: ${messagesToEmbed.length}/${messages.length} need embedding...`);

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

      // Prepare data for Chroma
      const chromaData = {
        ids: messagesToEmbed.map((m) => `msg-${m.id}`),
        embeddings,
        documents: texts,
        metadatas: messagesToEmbed.map((m) => ({
          source: m.source_name,
          project_path: m.project_path,
          session_id: m.session_id.toString(),
          message_id: m.id.toString(),
          role: m.role,
          timestamp: m.timestamp.getTime(),
          model: m.model ?? '',
          has_tool_use: m.role === 'tool',
          token_count: m.content_text.length,
        })),
      };

      // Upsert to Chroma (update if exists, insert if not)
      await upsertEmbeddings(config.chroma.collections.messages, chromaData);

      // Upsert to PostgreSQL
      for (let i = 0; i < messagesToEmbed.length; i++) {
        await query(
          `INSERT INTO embeddings (message_id, chroma_collection, chroma_id, embedding_model, dimensions, content_chars_at_embed)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (message_id, chroma_collection)
           DO UPDATE SET content_chars_at_embed = $6, embedding_model = $4`,
          [
            messagesToEmbed[i].id,
            config.chroma.collections.messages,
            `msg-${messagesToEmbed[i].id}`,
            config.embeddings.model,
            config.embeddings.dimensions,
            messagesToEmbed[i].content_text.length,
          ]
        );
      }

      stats.processed += messagesToEmbed.length;
      stats.skipped += messages.length - messagesToEmbed.length;
      console.log(`Embedded ${stats.processed} messages total (${stats.skipped} skipped)`);
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
       AND (
         e.id IS NULL  -- No embedding exists
         OR s.content_chars > COALESCE(e.content_chars_at_embed, 0)  -- Content has grown
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
      const textForEmbedding = await summarizeConversation(formattedMessages);

      // Generate embedding from summary or full text
      const embeddings = await generateEmbeddings([textForEmbedding.slice(0, 8000)]);

      // Upsert to Chroma sessions collection (update if exists)
      await upsertEmbeddings(config.chroma.collections.sessions, {
        ids: [`session-${session.id}`],
        embeddings,
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
            was_summarized: textForEmbedding.length < formattedMessages.join('').length,
            embedded_at: Date.now(),
          },
        ],
      });

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
