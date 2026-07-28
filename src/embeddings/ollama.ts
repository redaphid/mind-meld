import { Ollama } from "ollama";
import { config } from "../config.js";
import { summarizeConversation, SUMMARIZE_MODEL } from "./summarize.js";
import { withOllamaGate } from "./ollama-gate.js";

// Fetch wrapper with timeout and retry for transient failures
const fetchWithRetry: typeof fetch = async (input, init) => {
  const { timeoutMs, maxRetries, retryDelayMs } = config.ollama;
  const url = typeof input === "string" ? input : input.toString();
  const label = url.includes("/embed")
    ? "embed"
    : url.includes("/generate")
      ? "generate"
      : "ollama";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await withOllamaGate(() =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
      return response;
    } catch (error: any) {
      const isTimeout =
        error.name === "TimeoutError" ||
        error.code === "UND_ERR_HEADERS_TIMEOUT";
      const isConnectionError =
        error.code === "ECONNREFUSED" ||
        error.code === "ENOTFOUND" ||
        error.message?.includes("fetch failed");

      if ((isTimeout || isConnectionError) && attempt < maxRetries) {
        console.log(
          `${label}: attempt ${attempt} failed (${error.message}), retrying in ${retryDelayMs / 1000}s...`,
        );
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`${label}: all ${maxRetries} attempts failed`);
};

// Rephrase text using completely different wording to avoid triggering NaN bugs
async function rephraseText(text: string): Promise<string> {
  const ollama = getOllamaClient();

  const response = await ollama.generate({
    model: SUMMARIZE_MODEL,
    prompt: `/no_think
Rephrase the following text using completely different words and sentence structure while preserving the exact meaning. Use simple, plain language. Do not add any introduction or explanation, just output the rephrased text:

${text}`,
    stream: false,
    keep_alive: "30m",
  });

  return response.response.trim();
}

let client: Ollama | null = null;

// One ollama serves both bge-m3 (vectorization) and qwen3 (generation).
export function getOllamaClient(): Ollama {
  if (!client) {
    client = new Ollama({
      host: config.ollama.url,
      fetch: fetchWithRetry,
    });
  }
  return client;
}

// Generate embedding for a single text
export async function generateEmbedding(text: string): Promise<number[]> {
  const ollama = getOllamaClient();

  const response = await ollama.embed({
    model: config.embeddings.model,
    input: text,
    keep_alive: "30m",
  });

  return response.embeddings[0];
}

// Sanitize text for embedding - remove problematic characters
function sanitizeText(text: string): string {
  return text
    .replace(/\0/g, "") // Remove null bytes
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ") // Replace control characters with spaces
    .trim();
}

// bge-m3 rejects some inputs outright, two ways: a NaN bug on certain texts
// (ollama#13572), and a context-length 400 that no character heuristic predicts
// — 6k chars of id-dense text can blow the 8192-token window while 50k chars of
// prose fits inside it. Both recover identically: re-embed something shorter.
// Anything else is a real fault and must surface.
export const isRecoverableEmbedError = (error: any) => {
  const message = `${error?.message ?? ""} ${error?.error ?? ""}`;
  return (
    message.includes("NaN") || message.includes("exceeds the context length")
  );
};

// Generate embeddings for multiple texts in batch
// Returns null for texts that cannot be embedded (Ollama bug)
export async function generateEmbeddings(
  texts: string[],
): Promise<(number[] | null)[]> {
  const ollama = getOllamaClient();

  // Sanitize all input texts
  const sanitizedTexts = texts.map(sanitizeText);

  // Validate all texts are non-empty after sanitization
  for (let i = 0; i < sanitizedTexts.length; i++) {
    if (!sanitizedTexts[i]) {
      throw new Error(
        `Text at index ${i} is empty after sanitization (original length: ${texts[i].length})`,
      );
    }
  }

  let response;
  try {
    response = await ollama.embed({
      model: config.embeddings.model,
      input: sanitizedTexts,
      keep_alive: "30m",
    });
  } catch (error: any) {
    // One bad text fails the whole batch, so degrade to per-text rather than
    // letting it poison the other 49. The queue is ordered by id and never
    // skips, so a rethrow here stalls every message behind it, permanently.
    if (isRecoverableEmbedError(error)) {
      console.log(
        `Batch failed (${error.message || error.error}), retrying individually with summarization fallback...`,
      );
      return await generateEmbeddingsWithFallback(texts, sanitizedTexts);
    }
    throw error;
  }

  return response.embeddings;
}

// Retry failed embeddings individually with summarization fallback
async function generateEmbeddingsWithFallback(
  originalTexts: string[],
  sanitizedTexts: string[],
): Promise<(number[] | null)[]> {
  const ollama = getOllamaClient();
  const embeddings: (number[] | null)[] = [];

  for (let i = 0; i < sanitizedTexts.length; i++) {
    try {
      // Try original text first
      const response = await ollama.embed({
        model: config.embeddings.model,
        input: [sanitizedTexts[i]],
        keep_alive: "30m",
      });

      // Check for NaN
      const hasNaN = response.embeddings[0].some(
        (val) => isNaN(val) || !isFinite(val),
      );
      if (hasNaN) {
        throw new Error("NaN in embedding");
      }

      embeddings.push(response.embeddings[0]);
    } catch (error: any) {
      // If the original is unembeddable, try a shorter rewrite of it
      if (isRecoverableEmbedError(error)) {
        console.log(
          `  Text ${i} failed (${error.message || error.error}), trying with summarization...`,
        );

        try {
          const summarized = await summarizeConversation([sanitizedTexts[i]]);
          console.log(`  Summarized to: ${summarized.substring(0, 100)}...`);

          // Try embedding the summarized version
          const response = await ollama.embed({
            model: config.embeddings.model,
            input: [summarized],
            keep_alive: "30m",
          });

          const hasNaN = response.embeddings[0].some(
            (val) => isNaN(val) || !isFinite(val),
          );
          if (hasNaN) {
            throw new Error("NaN in summarized embedding");
          }

          console.log(`  ✅ Summarization worked for text ${i}`);
          embeddings.push(response.embeddings[0]);
        } catch (summaryError: any) {
          // If the summary is unembeddable too, try completely different words
          if (isRecoverableEmbedError(summaryError)) {
            console.log(
              `  Summary also unembeddable (${summaryError.message || summaryError.error}), trying with rephrasing...`,
            );

            try {
              // Ask Ollama to rephrase using completely different wording
              const rephrased = await rephraseText(sanitizedTexts[i]);
              console.log(`  Rephrased to: ${rephrased.substring(0, 100)}...`);

              // Try embedding the rephrased version
              const response = await ollama.embed({
                model: config.embeddings.model,
                input: [rephrased],
                keep_alive: "30m",
              });

              const hasNaN = response.embeddings[0].some(
                (val) => isNaN(val) || !isFinite(val),
              );
              if (hasNaN) {
                throw new Error("NaN in rephrased embedding");
              }

              console.log(`  ✅ Rephrasing worked for text ${i}`);
              embeddings.push(response.embeddings[0]);
            } catch (rephraseError: any) {
              // If even rephrasing fails, mark as un-embeddable and continue
              console.error(
                `\n⚠️  Text ${i} failed even after rephrasing - will mark as un-embeddable`,
              );
              console.error(
                `   Error: ${rephraseError.message || rephraseError}`,
              );
              console.error(
                `   Original text length: ${sanitizedTexts[i].length}`,
              );
              console.error(
                `   Original text (first 200 chars): ${sanitizedTexts[i].substring(0, 200)}\n`,
              );
              embeddings.push(null); // Return null to mark as un-embeddable
            }
          } else {
            // Not a recoverable embed failure — a real fault, surface it
            console.error(
              `\n🚨 CRITICAL: Text ${i} summarization failed with an unrecoverable error!`,
            );
            console.error(`   Error: ${summaryError.message || summaryError}`);
            throw summaryError;
          }
        }
      } else {
        throw error;
      }
    }
  }

  return embeddings;
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
    console.log("Model pulled successfully");
  }
}
