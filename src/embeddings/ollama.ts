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

// Sanitize text for embedding - remove problematic characters
function sanitizeText(text: string): string {
  return text
    .replace(/\0/g, '') // Remove null bytes
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ') // Replace control characters with spaces
    .trim()
}

// Generate embeddings for multiple texts in batch
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const ollama = getOllamaClient();

  // Sanitize all input texts
  const sanitizedTexts = texts.map(sanitizeText)

  // Validate all texts are non-empty after sanitization
  for (let i = 0; i < sanitizedTexts.length; i++) {
    if (!sanitizedTexts[i]) {
      throw new Error(`Text at index ${i} is empty after sanitization (original length: ${texts[i].length})`)
    }
  }

  const response = await ollama.embed({
    model: config.embeddings.model,
    input: sanitizedTexts,
  });

  // Verify no NaN values - if we get them, it's a bug we need to fix
  response.embeddings.forEach((emb, idx) => {
    const hasNaN = emb.some((val) => isNaN(val) || !isFinite(val))
    if (hasNaN) {
      throw new Error(
        `Embedding contains NaN/Infinity at index ${idx}\n` +
        `Original text length: ${texts[idx].length}\n` +
        `Sanitized text: ${sanitizedTexts[idx].substring(0, 100)}...\n` +
        `This should never happen - investigate the input text`
      )
    }
  })

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
