import { query, closePool } from '../../src/db/postgres.js';
import { config } from '../../src/config.js';
import { summarizeConversation } from '../../src/embeddings/summarize.js';
import { generateEmbeddings } from '../../src/embeddings/ollama.js';

async function testEmbeddingFlow() {
  console.log('Testing full embedding flow for sessions...\n');

  // Get a few sessions that need embedding
  const sessions = await query<{
    id: number;
    external_id: string;
    title: string;
    message_count: number;
  }>(
    `SELECT s.id, s.external_id, s.title, s.message_count
     FROM sessions s
     LEFT JOIN embeddings e ON e.chroma_collection = $1 AND e.chroma_id = 'session-' || s.id::text
     WHERE s.message_count > 0
       AND s.title != 'Warmup'
       AND e.id IS NULL
     LIMIT 5`,
    [config.chroma.collections.sessions]
  );

  console.log(`Testing ${sessions.rows.length} sessions\n`);

  for (const session of sessions.rows) {
    console.log(`\nTesting session ${session.id} (${session.external_id}):`);
    console.log(`  Title: ${session.title}`);
    console.log(`  Messages: ${session.message_count}`);

    try {
      // Get message content
      const messages = await query<{ content_text: string; role: string }>(
        `SELECT content_text, role FROM messages
         WHERE session_id = $1 AND content_text IS NOT NULL AND LENGTH(content_text) > 0
         ORDER BY sequence_num`,
        [session.id]
      );

      if (messages.rows.length === 0) {
        console.log('  ⚠️  No messages found');
        continue;
      }

      // Format messages
      const formattedMessages = messages.rows.map(
        (m) => `[${m.role.toUpperCase()}]: ${m.content_text}`
      );

      // Summarize
      console.log(`  Summarizing ${formattedMessages.length} messages...`);
      const summary = await summarizeConversation(formattedMessages);
      console.log(`  Summary length: ${summary.length} chars`);

      // Generate embedding
      console.log(`  Generating embedding...`);
      const embeddings = await generateEmbeddings([summary.slice(0, 8000)]);

      // Check for NaN
      const hasNaN = embeddings[0].some((val) => isNaN(val) || !isFinite(val));
      if (hasNaN) {
        console.log(`  ❌ FOUND NaN in embedding!`);
        console.log(`  Summary: ${summary.substring(0, 200)}...`);
      } else {
        console.log(`  ✅ Embedding OK (${embeddings[0].length} dimensions)`);
      }
    } catch (e) {
      console.log(`  ❌ Error: ${e}`);
    }
  }
}

testEmbeddingFlow()
  .then(() => closePool())
  .catch((e) => {
    console.error('Fatal error:', e);
    closePool();
    process.exit(1);
  });
