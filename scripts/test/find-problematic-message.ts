import { query, closePool } from '../../src/db/postgres.js';
import { generateEmbeddings } from '../../src/embeddings/ollama.js';

async function findProblematicMessage() {
  console.log('Binary searching for the problematic message...\n');

  // Get 100 messages
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

  console.log(`Testing ${messages.rows.length} messages\n`);

  // Binary search to find the problematic message
  let left = 0;
  let right = messages.rows.length;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const batch = messages.rows.slice(left, mid + 1);

    console.log(`Testing messages ${left} to ${mid} (${batch.length} messages)...`);

    try {
      const texts = batch.map(m => m.content_text);
      await generateEmbeddings(texts);
      console.log(`✅ Batch ${left}-${mid} OK`);

      // Success - problem is in the right half
      left = mid + 1;
    } catch (e: any) {
      if (e.message?.includes('NaN')) {
        console.log(`❌ Batch ${left}-${mid} has NaN`);

        // Failure - problem is in this batch
        if (batch.length === 1) {
          // Found it!
          const msg = batch[0];
          console.log(`\n🎯 FOUND PROBLEMATIC MESSAGE:`);
          console.log(`   ID: ${msg.id}`);
          console.log(`   Length: ${msg.content_text.length}`);
          console.log(`   Content: ${msg.content_text.substring(0, 200)}...`);

          // Show hex dump of first 100 chars to check for weird characters
          const hex = Buffer.from(msg.content_text.substring(0, 100)).toString('hex');
          console.log(`   Hex: ${hex}`);
          break;
        }

        // Narrow down
        right = mid;
      } else {
        throw e;
      }
    }
  }
}

findProblematicMessage()
  .then(() => closePool())
  .catch((e) => {
    console.error('Fatal error:', e);
    closePool();
    process.exit(1);
  });
