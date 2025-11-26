import { Ollama } from 'ollama';
import { config } from '../config.js';

let client: Ollama | null = null;

export function getOllamaClient(): Ollama {
  if (!client) {
    client = new Ollama({ host: config.ollama.url });
  }
  return client;
}

// Generate embedding for a single text
export async function generateEmbedding(text: string): Promise<number[]> {
  const ollama = getOllamaClient();

  const response = await ollama.embed({
    model: config.embeddings.model,
    input: text,
  });

  return response.embeddings[0];
}

// Generate embeddings for multiple texts in batch
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const ollama = getOllamaClient();

  const response = await ollama.embed({
    model: config.embeddings.model,
    input: texts,
  });

  return response.embeddings;
}

// Check if embedding model is available
export async function checkEmbeddingModel(): Promise<boolean> {
  try {
    const ollama = getOllamaClient();
    const models = await ollama.list();
    return models.models.some((m) => m.name.includes(config.embeddings.model));
  } catch {
    return false;
  }
}

// Pull embedding model if not available
export async function ensureEmbeddingModel(): Promise<void> {
  const isAvailable = await checkEmbeddingModel();

  if (!isAvailable) {
    console.log(`Pulling embedding model ${config.embeddings.model}...`);
    const ollama = getOllamaClient();
    await ollama.pull({ model: config.embeddings.model });
    console.log('Model pulled successfully');
  }
}
