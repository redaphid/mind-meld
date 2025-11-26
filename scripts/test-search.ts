#!/usr/bin/env tsx
import { ChromaClient } from 'chromadb';
import { OllamaEmbeddingFunction } from '@chroma-core/ollama';
import { config } from '../src/config.js';

async function testSearch() {
  const client = new ChromaClient({ path: config.chroma.url });

  const embedder = new OllamaEmbeddingFunction({
    url: config.embeddings.url,
    model: config.embeddings.model,
  });

  const collection = await client.getCollection({
    name: config.chroma.collections.messages,
    embeddingFunction: embedder,
  });

  const query = process.argv[2] || 'webhook slack notification';
  console.log('Searching for:', query);

  const results = await collection.query({
    queryTexts: [query],
    nResults: 5,
    include: ['documents', 'metadatas', 'distances'],
  });

  console.log('\nSearch results:');
  for (let i = 0; i < results.ids[0].length; i++) {
    const distance = results.distances?.[0]?.[i];
    const doc = results.documents?.[0]?.[i];
    const meta = results.metadatas?.[0]?.[i];

    console.log(`\n--- Result ${i + 1} (distance: ${distance?.toFixed(4)}) ---`);
    console.log('Project:', meta?.project_path);
    console.log('Role:', meta?.role);
    console.log('Doc:', doc?.slice(0, 300));
  }
}

testSearch().catch(console.error);
