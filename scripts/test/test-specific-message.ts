import { query, closePool } from '../../src/db/postgres.js';
import { config } from '../../src/config.js';
import { generateEmbeddings } from '../../src/embeddings/ollama.js';

async function testSpecificMessages() {
  console.log('Testing specific messages that are failing to embed...\n');

  // Get the first 5 messages that need embedding
  const messages = await query<{
    id: number;
    content_text: string;
    role: string;
  }>(
    `SELECT m.id, m.content_text, m.role
     FROM messages m
     LEFT JOIN embeddings e ON e.message_id = m.id
     WHERE m.content_text IS NOT NULL
       AND LENGTH(m.content_text) > 10
       AND e.id IS NULL
     ORDER BY m.id
     LIMIT 5`
  );

  console.log(`Testing ${messages.rows.length} messages\n`);

  for (const msg of messages.rows) {
    console.log(`\n=== Message ${msg.id} (${msg.role}) ===`);
    console.log(`Length: ${msg.content_text.length} chars`);
    console.log(`Preview: ${msg.content_text.substring(0, 200)}...`);

    try {
      console.log('Attempting to generate embedding...');
      const embeddings = await generateEmbeddings([msg.content_text]);

      // Check for NaN
      const hasNaN = embeddings[0].some((val) => isNaN(val) || !isFinite(val));
      if (hasNaN) {
        console.log('❌ EMBEDDING CONTAINS NaN!');
        const nanIndices = embeddings[0]
          .map((val, idx) => (isNaN(val) || !isFinite(val) ? idx : -1))
          .filter(idx => idx !== -1);
        console.log(`   NaN at indices: ${nanIndices.slice(0, 10).join(', ')}${nanIndices.length > 10 ? '...' : ''}`);
      } else {
        console.log('✅ Embedding OK');
      }
    } catch (e: any) {
      console.log('❌ ERROR:', e.message || e);
      if (e.stack) {
        console.log('Stack:', e.stack.split('\n').slice(0, 3).join('\n'));
      }
    }
  }
}

testSpecificMessages()
  .then(() => closePool())
  .catch((e) => {
    console.error('Fatal error:', e);
    closePool();
    process.exit(1);
  });
