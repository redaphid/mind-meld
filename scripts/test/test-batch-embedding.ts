import { query, closePool } from '../../src/db/postgres.js';
import { generateEmbeddings } from '../../src/embeddings/ollama.js';
import { Ollama } from 'ollama';
import { config } from '../../src/config.js';

async function testBatchEmbedding() {
  console.log('Testing batch embedding to reproduce NaN issue...\n');

  // Get 100 messages like the real batch process
  const messages = await query<{
    id: number;
    content_text: string;
  }>(
    `SELECT m.id, m.content_text
     FROM messages m
     LEFT JOIN embeddings e ON e.message_id = m.id
     WHERE m.content_text IS NOT NULL
       AND LENGTH(m.content_text) > 10
       AND e.id IS NULL
     ORDER BY m.id
     LIMIT 100`
  );

  console.log(`Testing batch of ${messages.rows.length} messages\n`);

  const texts = messages.rows.map(m => m.content_text);

  try {
    console.log('Calling generateEmbeddings with batch of 100...');
    const embeddings = await generateEmbeddings(texts);

    console.log(`✅ Got ${embeddings.length} embeddings`);

    // Check each for NaN
    let nanCount = 0;
    embeddings.forEach((emb, idx) => {
      const hasNaN = emb.some(val => isNaN(val) || !isFinite(val));
      if (hasNaN) {
        nanCount++;
        console.log(`❌ Embedding ${idx} (message ${messages.rows[idx].id}) has NaN!`);
        console.log(`   Text length: ${texts[idx].length}`);
        console.log(`   Text preview: ${texts[idx].substring(0, 100)}...`);
      }
    });

    if (nanCount === 0) {
      console.log('\n✅ All embeddings are clean - no NaN values found');
    } else {
      console.log(`\n❌ Found ${nanCount} embeddings with NaN values`);
    }

  } catch (e: any) {
    console.log('\n❌ Batch embedding failed!');
    console.log('Error:', e.message || e);

    // Try to get more details from the error
    if (e.response) {
      console.log('Response status:', e.response.status);
      console.log('Response data:', e.response.data);
    }

    // Now test calling Ollama directly to see the raw response
    console.log('\n--- Testing direct Ollama call ---');
    try {
      const ollama = new Ollama({ host: config.ollama.url });
      const response = await ollama.embed({
        model: config.embeddings.model,
        input: texts.slice(0, 5), // Just first 5 to be quick
      });

      console.log('Direct Ollama response received');
      console.log('Embeddings count:', response.embeddings.length);

      // Check for NaN in raw response
      response.embeddings.forEach((emb, idx) => {
        const hasNaN = emb.some((val: number) => isNaN(val) || !isFinite(val));
        if (hasNaN) {
          console.log(`❌ Direct call: Embedding ${idx} has NaN!`);
        }
      });

    } catch (directError: any) {
      console.log('Direct Ollama call also failed:', directError.message);
    }
  }
}

testBatchEmbedding()
  .then(() => closePool())
  .catch((e) => {
    console.error('Fatal error:', e);
    closePool();
    process.exit(1);
  });
