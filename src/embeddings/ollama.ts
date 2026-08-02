import { Ollama } from "ollama";
import { config } from "../config.js";
import { shrinkBySummarizing, SUMMARIZE_MODEL } from "./summarize.js";
import { withOllamaGate } from "./ollama-gate.js";

// How long to wait before re-sending a request the upstream refused with 503.
// Parses Retry-After, which RFC 9110 allows to be either delta-seconds or an
// HTTP-date, and clamps the result to retryMaxDelayMs. A missing, malformed, or
// already-elapsed header falls back to the ordinary retry delay rather than
// retrying instantly — a hot loop against a closed gate is the failure mode
// this whole path exists to prevent.
export const retryAfterMs = (header: string | null): number => {
  const { retryDelayMs, retryMaxDelayMs } = config.ollama;
  if (!header) return retryDelayMs;

  const seconds = Number(header);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - Date.now();

  if (!Number.isFinite(ms) || ms <= 0) return retryDelayMs;
  return Math.min(ms, retryMaxDelayMs);
};

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

      // A GPU gate in front of Ollama (ollama-proxy) refuses GPU-heavy work
      // with 503 + Retry-After while a game or ComfyUI holds VRAM. fetch()
      // does not throw on 503 — it resolves — so without this the response
      // reaches the Ollama client, which turns it into a ResponseError the
      // catch below does not recognise as transient. The run then dies and
      // Docker's restart policy relaunches it straight back into the closed
      // gate, hammering the proxy instead of waiting for it. The proxy queues
      // nothing, so holding the request here is the caller's job.
      //
      // The final attempt deliberately returns the 503 rather than throwing:
      // the body carries the proxy's own explanation of which condition is
      // holding it, and letting the Ollama client surface that verbatim is far
      // more useful than an error we invent here.
      if (response.status === 503 && attempt < maxRetries) {
        const waitMs = retryAfterMs(response.headers.get("retry-after"));
        // Nothing reads this body, and an undrained one keeps the socket open.
        await response.body?.cancel().catch(() => {});
        console.log(
          `${label}: upstream returned 503 (attempt ${attempt}/${maxRetries}), waiting ${Math.round(waitMs / 1000)}s before retrying...`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

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

// truncate:false is load-bearing everywhere we embed. Ollama's default silently
// clips anything past the 8192-token window and still returns a vector — built from
// a prefix, with no error and no record that it happened. Measured 2026-07-28: 64% of
// 5-8k-char messages and 100% of session summaries over ~22k chars were being clipped
// this way. Refusing lets the caller summarize instead, which loses far less.
const NO_TRUNCATE = { truncate: false, keep_alive: "30m" } as const;

// Generate embedding for a single text
export async function generateEmbedding(text: string): Promise<number[]> {
  const ollama = getOllamaClient();

  const response = await ollama.embed({
    model: config.embeddings.model,
    input: text,
    ...NO_TRUNCATE,
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

// bge-m3 rejects input two ways, and they need opposite remedies:
//   oversize — too many tokens for the 8192 window. Only shorter text helps.
//   NaN      — the flash-attention bug (ollama#13572). Only different wording helps.
// Neither is predictable from character count: 6k chars of id-dense text can
// overflow while 26k chars of prose fits. Anything else is a real fault.
const errorText = (error: any) =>
  `${error?.message ?? ""} ${error?.error ?? ""}`;

export const isOversizeEmbedError = (error: any) =>
  errorText(error).includes("exceeds the context length");

export const isNaNEmbedError = (error: any) => errorText(error).includes("NaN");

export const isRecoverableEmbedError = (error: any) =>
  isOversizeEmbedError(error) || isNaNEmbedError(error);

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
      ...NO_TRUNCATE,
    });
  } catch (error: any) {
    // One bad text fails the whole batch, so degrade to per-text rather than
    // letting it poison the other 49. The queue is ordered by id and never
    // skips, so a rethrow here stalls every message behind it, permanently.
    if (isRecoverableEmbedError(error)) {
      console.log(
        `Batch failed (${error.message || error.error}), re-embedding individually...`,
      );
      return await generateEmbeddingsWithFallback(sanitizedTexts);
    }
    throw error;
  }

  return response.embeddings;
}

// How many times we may rewrite one text before giving up on it. Each round costs
// a qwen3 pass, so this bounds the damage a pathological input can do to sync time.
const MAX_SHRINK_ROUNDS = 3;

// Shrink by summarizing, never by cutting. A hard slice keeps a prefix and throws
// away the tail unread; a summary keeps what the whole text was about. Which rewrite
// we reach for depends on why bge-m3 refused: oversize needs fewer tokens, NaN needs
// different words at the same length.
const rewriteForRetry = async (error: any, text: string) => {
  if (isOversizeEmbedError(error)) return shrinkBySummarizing(text);
  return rephraseText(text);
};

// Embed one text, rewriting it as many times as it takes to fit. Returns null only
// when the rewrites are exhausted or the summarizer itself refuses the text.
const embedWithShrinking = async (
  text: string,
  label: string,
): Promise<number[] | null> => {
  const ollama = getOllamaClient();
  let candidate = text;

  for (let round = 0; round <= MAX_SHRINK_ROUNDS; round++) {
    try {
      const response = await ollama.embed({
        model: config.embeddings.model,
        input: [candidate],
        ...NO_TRUNCATE,
      });

      const [embedding] = response.embeddings;
      if (embedding.some((value) => isNaN(value) || !isFinite(value))) {
        throw new Error("NaN in embedding");
      }

      if (round > 0) {
        console.log(
          `  ✅ ${label} embedded after ${round} rewrite(s) (${text.length} → ${candidate.length} chars)`,
        );
      }
      return embedding;
    } catch (error: any) {
      if (!isRecoverableEmbedError(error)) throw error;

      if (round === MAX_SHRINK_ROUNDS) {
        console.error(
          `⚠️  ${label} still unembeddable after ${MAX_SHRINK_ROUNDS} rewrites (${candidate.length} chars): ${error.message || error.error}`,
        );
        return null;
      }

      const reason = isOversizeEmbedError(error) ? "oversize" : "NaN";
      const before = candidate.length;
      try {
        candidate = await rewriteForRetry(error, candidate);
      } catch (rewriteError: any) {
        // The summarizer refused (injection sentinel, control marker, empty
        // output). There is no shorter text to try, so stop cleanly.
        console.error(
          `⚠️  ${label} rewrite failed: ${rewriteError.message || rewriteError}`,
        );
        return null;
      }
      console.log(
        `  ${label} ${reason} → rewrote ${before} → ${candidate.length} chars (round ${round + 1})`,
      );
    }
  }

  return null;
};

// Re-embed a failed batch one text at a time, so one bad input costs one vector
// instead of fifty.
const generateEmbeddingsWithFallback = async (
  sanitizedTexts: string[],
): Promise<(number[] | null)[]> => {
  const embeddings: (number[] | null)[] = [];
  for (let i = 0; i < sanitizedTexts.length; i++) {
    embeddings.push(await embedWithShrinking(sanitizedTexts[i], `text ${i}`));
  }
  return embeddings;
};

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
