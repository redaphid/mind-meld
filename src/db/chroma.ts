import { ChromaClient, Collection } from 'chromadb';
import { OllamaEmbeddingFunction } from '@chroma-core/ollama';
import { config } from '../config.js';

let client: ChromaClient | null = null;
let embeddingFunction: OllamaEmbeddingFunction | null = null;
let collections: Record<string, Collection> = {};

export function getChromaClient(): ChromaClient {
  if (!client) {
    client = new ChromaClient({
      host: new URL(config.chroma.url).hostname,
      port: parseInt(new URL(config.chroma.url).port) || 8000,
    });
  }
  return client;
}

export function getEmbeddingFunction(): OllamaEmbeddingFunction {
  if (!embeddingFunction) {
    embeddingFunction = new OllamaEmbeddingFunction({
      url: config.ollama.url,
      model: config.embeddings.model,
    });
  }
  return embeddingFunction;
}

export async function getCollection(name: string): Promise<Collection> {
  if (!collections[name]) {
    const chromaClient = getChromaClient();
    const embedder = getEmbeddingFunction();
    collections[name] = await chromaClient.getOrCreateCollection({
      name,
      embeddingFunction: embedder,
      metadata: {
        'hnsw:space': 'cosine',
        description: `Mindmeld ${name} collection`,
        embedding_model: config.embeddings.model,
        dimensions: config.embeddings.dimensions.toString(),
      },
    });
  }
  return collections[name];
}

export async function getMessagesCollection(): Promise<Collection> {
  return getCollection(config.chroma.collections.messages);
}

export async function getSessionsCollection(): Promise<Collection> {
  return getCollection(config.chroma.collections.sessions);
}

export async function getProjectsCollection(): Promise<Collection> {
  return getCollection(config.chroma.collections.projects);
}

// Add embeddings to collection
export async function addEmbeddings(
  collectionName: string,
  data: {
    ids: string[];
    embeddings: number[][];
    documents: string[];
    metadatas: Record<string, string | number | boolean>[];
  }
): Promise<void> {
  const collection = await getCollection(collectionName);
  await collection.add({
    ids: data.ids,
    embeddings: data.embeddings,
    documents: data.documents,
    metadatas: data.metadatas,
  });
}

// Query similar documents
export async function querySimilar(
  collectionName: string,
  queryEmbedding: number[],
  nResults = 10,
  whereFilter?: Record<string, unknown>,
  // Ask Chroma to hand back each hit's OWN vector alongside its distance.
  //
  // The noise penalty (src/mcp/noise.ts) has to compare a result against the
  // noise clusters, which means it needs a vector for that result. The obvious
  // source is `sessions.centroid_vector`, and it is the wrong one: 5 of the 6
  // sessions actually observed polluting a live search have no centroid at all,
  // so a centroid-based penalty would silently skip exactly the rows it exists
  // to demote. The vector that CAUSED the hit is always available and is a
  // truer subject anyway -- it is the thing that matched.
  includeEmbeddings = false
): Promise<{
  ids: string[][];
  documents: (string | null)[][];
  metadatas: (Record<string, unknown> | null)[][];
  distances: (number | null)[][] | null;
  embeddings?: (number[] | null)[][] | null;
}> {
  const collection = await getCollection(collectionName);
  const include = ['documents', 'metadatas', 'distances'];
  if (includeEmbeddings) include.push('embeddings');
  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults,
    where: whereFilter as Parameters<typeof collection.query>[0]['where'],
    include: include as Parameters<typeof collection.query>[0]['include'],
  });
  return results;
}

// Every vector in a collection, ids included. Only ever called against the
// noise collection, which is bounded by how many sessions agents have actually
// reported -- a number in the hundreds, not the hundreds of thousands the
// message collection holds. Do not point this at a searchable collection.
export async function getAllEmbeddings(
  collectionName: string
): Promise<{ ids: string[]; embeddings: number[][] }> {
  const collection = await getCollection(collectionName);
  const result = await collection.get({ include: ['embeddings'] });
  const embeddings = (result.embeddings ?? []) as unknown as (number[] | null)[];
  const ids: string[] = [];
  const vectors: number[][] = [];
  result.ids.forEach((id, i) => {
    const vec = embeddings[i];
    if (vec && vec.length > 0) {
      ids.push(id);
      vectors.push(vec);
    }
  });
  return { ids, embeddings: vectors };
}

// Drop ids from a collection. Used by unreportUselessSession to take a session
// back out of the noise corpus, so that un-reporting genuinely undoes both
// halves of a report rather than only the visible tag.
export async function deleteEmbeddings(collectionName: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const collection = await getCollection(collectionName);
  await collection.delete({ ids });
}

// Check if ID exists in collection
export async function hasId(collectionName: string, id: string): Promise<boolean> {
  const collection = await getCollection(collectionName);
  const result = await collection.get({
    ids: [id],
    include: [],
  });
  return result.ids.length > 0;
}

// Get embedding metadata by ID (for checking if re-embedding is needed)
export async function getEmbeddingMetadata(
  collectionName: string,
  id: string
): Promise<Record<string, unknown> | null> {
  const collection = await getCollection(collectionName);
  const result = await collection.get({
    ids: [id],
    include: ['metadatas'],
  });
  if (result.ids.length === 0 || !result.metadatas?.[0]) {
    return null;
  }
  return result.metadatas[0] as Record<string, unknown>;
}

// Update or add embedding (upsert)
export async function upsertEmbeddings(
  collectionName: string,
  data: {
    ids: string[];
    embeddings: number[][];
    documents: string[];
    metadatas: Record<string, string | number | boolean>[];
  }
): Promise<void> {
  const collection = await getCollection(collectionName);
  await collection.upsert({
    ids: data.ids,
    embeddings: data.embeddings,
    documents: data.documents,
    metadatas: data.metadatas,
  });
}

// Delete by IDs
export async function deleteByIds(collectionName: string, ids: string[]): Promise<void> {
  const collection = await getCollection(collectionName);
  await collection.delete({ ids });
}

// Get collection stats
export async function getCollectionStats(collectionName: string): Promise<{
  count: number;
  name: string;
}> {
  const collection = await getCollection(collectionName);
  const count = await collection.count();
  return { count, name: collectionName };
}

// List all collections
export async function listCollections(): Promise<string[]> {
  const chromaClient = getChromaClient();
  const cols = await chromaClient.listCollections();
  // API returns strings directly in newer versions
  return cols.map((c) => (typeof c === 'string' ? c : (c as { name: string }).name));
}
