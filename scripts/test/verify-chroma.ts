import { getCollection } from '../../src/db/chroma.js';

async function check() {
  const col = await getCollection('convo-messages');
  const count = await col.count();
  console.log('Count:', count);

  const sample = await col.get({ limit: 3, include: ['embeddings', 'metadatas'] });
  console.log('Sample IDs:', sample.ids);
  console.log('Has embeddings:', sample.embeddings && sample.embeddings.length > 0);
  if (sample.embeddings?.[0]) {
    console.log('Embedding dimensions:', sample.embeddings[0].length);
  }
  console.log('Sample metadata:', JSON.stringify(sample.metadatas?.[0], null, 2));
}

check().catch(console.error);
