import { ChromaClient } from 'chromadb';
import { config } from '../../src/config.js';

async function checkChromaForNaN() {
  console.log('Connecting to Chroma at', config.chroma.url);
  const client = new ChromaClient({ path: config.chroma.url });

  const collections = await client.listCollections();
  console.log(`\nFound ${collections.length} collections\n`);

  for (const collectionInfo of collections) {
    console.log(`\nChecking collection: ${collectionInfo.name}`);

    try {
      const collection = await client.getCollection({ name: collectionInfo.name });
      const count = await collection.count();
      console.log(`  Total items: ${count}`);

      // Get a sample of items to check
      const sampleSize = Math.min(1000, count);
      const result = await collection.get({
        limit: sampleSize,
        include: ['embeddings', 'metadatas']
      });

      let nanCount = 0;
      let nanItems: Array<{ id: string; nanFields: string[] }> = [];

      result.ids.forEach((id, idx) => {
        const nanFields: string[] = [];

        // Check embedding for NaN
        const embedding = result.embeddings?.[idx];
        if (embedding) {
          const hasNaNInEmbedding = embedding.some((val:number) => isNaN(val) || !isFinite(val));
          if (hasNaNInEmbedding) {
            nanFields.push('embedding');
          }
        }

        // Check metadata for NaN
        const metadata = result.metadatas?.[idx];
        if (metadata) {
          Object.entries(metadata).forEach(([key, value]) => {
            if (typeof value === 'number' && (isNaN(value) || !isFinite(value))) {
              nanFields.push(`metadata.${key}=${value}`);
            }
          });
        }

        if (nanFields.length > 0) {
          nanCount++;
          nanItems.push({ id, nanFields });
          if (nanItems.length <= 10) {  // Show first 10
            console.log(`  ❌ Found NaN in ${id}:`);
            console.log(`     ${nanFields.join(', ')}`);
            if (metadata) {
              console.log(`     Metadata:`, JSON.stringify(metadata, null, 2));
            }
          }
        }
      });

      if (nanCount > 0) {
        console.log(`\n  ❌ FOUND ${nanCount} items with NaN values in ${collectionInfo.name}`);
        if (nanCount > 10) {
          console.log(`     (showing first 10, total: ${nanCount})`);
        }
      } else {
        console.log(`  ✅ No NaN values found in sample of ${sampleSize} items`);
      }

    } catch (e) {
      console.error(`  Error checking collection: ${e}`);
    }
  }
}

checkChromaForNaN()
  .then(() => {
    console.log('\nDone');
    process.exit(0);
  })
  .catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
