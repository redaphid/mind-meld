import { config } from "../config.js";

export const SUMMARIZE_MODEL = config.embeddings.summarizeModel;

// Fetch with timeout and retry on transient failures
const fetchWithRetry = async (
  url: string,
  options: RequestInit,
  label: string,
): Promise<Response> => {
  const { timeoutMs, maxRetries, retryDelayMs } = config.ollama;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
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
const MAX_CHARS_BEFORE_SUMMARIZE = 8000;
// Context window for every summarizer call. Ollama's default is 4096, which
// silently truncated 60k-char chunks to ~25% visibility; worse, a prompt that
// exactly fills the window makes the model emit 1 token (an empty summary).
// 16384 won the 2026-06-10 benchmark: qwen3:8b at 28k-char chunks scored 10/15
// fact recall in 38s vs 4/15 at the truncated default. 32k ctx with 60k chunks
// scored worse (5/15) — qwen3 can't exploit chunks that large even when visible.
const SUMMARIZER_NUM_CTX = 16384;
// The single ceiling on how much text qwen3:8b summarizes in one call. Governs
// both session chunking (convo-chunks middle tier, via CHUNK_SIZE_CHARS) and the
// summarizeConversation split, so the two paths can never disagree on "too big".
// Must fit SUMMARIZER_NUM_CTX with room to generate: 28000 chars is ~8k tokens
// typical, ~11k worst case (dense JSON), leaving headroom for the prompt
// boilerplate and num_predict inside the 16384 window.
const MAX_SUMMARIZER_INPUT_CHARS = 28000;
// Cap at bge-m3's 8192-token context — summaries longer than this get truncated
// at embed time, so generating more is wasted compute. This is the budget for
// the *final* combined summary that actually gets embedded.
const MAX_SUMMARY_TOKENS = 8192;
// Per-chunk summaries feed the combine step, not bge-m3. Typical output is
// ~1k tokens; at 0.3 temperature qwen occasionally rambles to the cap, so we
// bound it well below the combine budget to prevent runaway chunks from
// inflating the combine input (seen in the wild: one chunk ballooned to 30k
// chars / ~7600 tokens, deterministic rerun of same input produced 3075 chars).
const MAX_CHUNK_SUMMARY_TOKENS = 3072;
// Floor for the FINAL summary only (chunk summaries are kept regardless — see
// summarizeChunk) — rejects refusals / near-empty garbage ("<done>", "The"),
// not genuinely terse but real summaries.
const MIN_SUMMARY_CHARS = 100;

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
  prompt_eval_count?: number;
}

export class TruncationError extends Error {
  constructor(label: string, promptEvalCount: number) {
    super(
      `${label}: prompt filled the ${SUMMARIZER_NUM_CTX}-token context (prompt_eval_count=${promptEvalCount}); ollama silently truncated the input. Shrink MAX_SUMMARIZER_INPUT_CHARS or raise SUMMARIZER_NUM_CTX.`,
    );
    this.name = "TruncationError";
  }
}

// Ollama truncates oversized prompts to num_ctx - 1 with no error; a prompt
// that fills the window also leaves no room to generate (the model emits a
// single EOS token → empty summary). 64 tokens of slack distinguishes "large
// but legal" from "was cut off".
const assertNotTruncated = (
  result: OllamaGenerateResponse,
  label: string,
): void => {
  const count = result.prompt_eval_count;
  if (count === undefined) return;
  if (count < SUMMARIZER_NUM_CTX - 64) return;
  throw new TruncationError(label, count);
};

// Summarize a single chunk of text
export async function summarizeChunk(
  text: string,
  isChunkOfMany: boolean,
): Promise<string> {
  const contextNote = isChunkOfMany
    ? "This is one chunk of a larger conversation. Preserve all technical details for later combination."
    : "";

  const prompt = `You are writing a dense technical summary of a coding conversation. The summary is used for semantic search, so it must describe what actually happened — not reproduce it.

${contextNote}

Cover, as prose:
- Goal: what the user was trying to accomplish
- Actions: key things tried, in order
- Findings: errors hit, root causes, what worked vs failed
- Decisions: what was chosen and why
- Outcome: final state, what's still open
- Concrete nouns: file paths, function/class/variable names, commands, library names, error messages — inline, not in code blocks

Hard rules:
- NO code blocks, NO triple backticks, NO verbatim command output, NO JSON dumps.
- Do NOT invent examples or sample data. Only describe things actually discussed.
- Mention names inline (e.g. "fixed a regex bug in scripts/embed-progress.sh").
- If the conversation is short or trivial, write a short summary — do not pad.
- Output the summary only. No preamble, no headings like "Summary:".

CONVERSATION:
${text}

SUMMARY:`;

  const response = await fetchWithRetry(
    `${config.ollama.url}/api/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SUMMARIZE_MODEL,
        prompt,
        stream: false,
        think: false,
        keep_alive: "30m",
        options: {
          temperature: 0.3,
          num_ctx: SUMMARIZER_NUM_CTX,
          num_predict: isChunkOfMany
            ? MAX_CHUNK_SUMMARY_TOKENS
            : MAX_SUMMARY_TOKENS,
        },
      }),
    },
    "summarizeChunk",
  );

  if (!response.ok) {
    console.error(`Summarization failed: ${response.status}`);
    throw new Error(`Summarization failed: ${response.status}`);
  }

  const result = (await response.json()) as OllamaGenerateResponse;
  assertNotTruncated(result, "summarizeChunk");

  // Clean up qwen3's thinking tags if present
  let summary = result.response;
  summary = summary.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // A mid-transcript chunk summary is intermediate — keep whatever the model
  // produced rather than throwing away the chunk. Only the final single-pass
  // summary enforces the floor, to keep refusals/garbage out of session search.
  if (!isChunkOfMany && summary.length < MIN_SUMMARY_CHARS) {
    console.error(
      `Rejected summary (${summary.length} chars): ${JSON.stringify(summary)}`,
    );
    throw new Error(
      `Summary too short (${summary.length} chars < ${MIN_SUMMARY_CHARS}); likely prompt-injected or refused`,
    );
  }

  return summary;
}

// Combine multiple summaries into one
export async function combineSummaries(summaries: string[]): Promise<string> {
  const combined = summaries.join("\n\n---\n\n");

  // If combined summaries are short enough, return as-is
  if (combined.length <= MAX_CHARS_BEFORE_SUMMARIZE) {
    return combined;
  }

  // If combined summaries fit in one chunk, summarize them
  if (combined.length <= MAX_SUMMARIZER_INPUT_CHARS) {
    console.log(
      `Combining ${summaries.length} chunk summaries (${combined.length} chars)...`,
    );
    const startedAt = performance.now();

    const prompt = `Merge the following chunk summaries of a single coding conversation into one coherent summary.

Rules:
- Preserve concrete nouns from each chunk (file paths, function names, error messages, decisions) inline as prose.
- Remove redundancy — if two chunks mention the same thing, say it once.
- Maintain chronological flow where it matters.
- NO code blocks, NO triple backticks, NO verbatim output, NO invented examples.
- Output the merged summary only. No preamble, no "Combined Summary:" heading.

CHUNK SUMMARIES:
${combined}

MERGED SUMMARY:`;

    let response: Response;
    try {
      response = await fetchWithRetry(
        `${config.ollama.url}/api/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: SUMMARIZE_MODEL,
            prompt,
            stream: false,
            think: false,
            keep_alive: "30m",
            options: {
              temperature: 0.3,
              num_ctx: SUMMARIZER_NUM_CTX,
              num_predict: MAX_SUMMARY_TOKENS,
            },
          }),
        },
        "combineSummaries",
      );
    } catch {
      // Fall back to concatenation on persistent failure
      return combined.slice(0, MAX_CHARS_BEFORE_SUMMARIZE * 3);
    }

    if (!response.ok) {
      // Fall back to concatenation
      return combined.slice(0, MAX_CHARS_BEFORE_SUMMARIZE * 3);
    }

    const result = (await response.json()) as OllamaGenerateResponse;
    assertNotTruncated(result, "combineSummaries");
    let summary = result.response;
    summary = summary.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    console.log(
      `Combined to ${summary.length} chars in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
    );
    return summary;
  }

  // Combined summaries are too long - recursively chunk and summarize
  console.log(
    `Combined summaries too long (${combined.length} chars), chunking recursively...`,
  );
  return summarizeConversation(summaries);
}

// Split messages into chunks that fit within context window.
// Returns chunks with the original array indices they span — callers that need
// to map chunks back to message IDs can use startIndex/endIndex.
export interface MessageChunk {
  messages: string[];
  startIndex: number;
  endIndex: number; // inclusive
}

export function chunkMessagesWithIndices(
  messages: string[],
  maxChars: number,
): MessageChunk[] {
  // A single message can exceed maxChars (one giant tool result) — split it
  // into pieces that keep the original message index, so no chunk can ever
  // outgrow the summarizer's context window. Adjacent chunks holding pieces of
  // the same message share that boundary index.
  const pieceMax = maxChars - 10;
  const pieces: { text: string; index: number }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.length <= pieceMax) {
      pieces.push({ text: message, index: i });
      continue;
    }
    for (let offset = 0; offset < message.length; offset += pieceMax) {
      pieces.push({ text: message.slice(offset, offset + pieceMax), index: i });
    }
  }

  const chunks: MessageChunk[] = [];
  let currentMessages: string[] = [];
  let currentStart = 0;
  let currentEnd = 0;
  let currentLength = 0;

  for (const piece of pieces) {
    const pieceLength = piece.text.length + 10;

    if (currentLength + pieceLength > maxChars && currentMessages.length > 0) {
      chunks.push({
        messages: currentMessages,
        startIndex: currentStart,
        endIndex: currentEnd,
      });
      currentMessages = [piece.text];
      currentStart = piece.index;
      currentEnd = piece.index;
      currentLength = pieceLength;
      continue;
    }

    if (currentMessages.length === 0) currentStart = piece.index;
    currentMessages.push(piece.text);
    currentEnd = piece.index;
    currentLength += pieceLength;
  }

  if (currentMessages.length > 0) {
    chunks.push({
      messages: currentMessages,
      startIndex: currentStart,
      endIndex: currentEnd,
    });
  }

  return chunks;
}

function chunkMessages(messages: string[], maxChars: number): string[][] {
  return chunkMessagesWithIndices(messages, maxChars).map((c) => c.messages);
}

export const CHUNK_SIZE_CHARS = MAX_SUMMARIZER_INPUT_CHARS;
export const SHORT_CONVERSATION_CHARS = MAX_CHARS_BEFORE_SUMMARIZE;

export async function summarizeConversation(
  messages: string[],
): Promise<string> {
  const combined = messages.join("\n\n---\n\n");

  // If short enough, no summarization needed
  if (combined.length <= MAX_CHARS_BEFORE_SUMMARIZE) {
    return combined;
  }

  // If fits in one chunk, summarize directly
  if (combined.length <= MAX_SUMMARIZER_INPUT_CHARS) {
    console.log(`Summarizing conversation (${combined.length} chars)...`);
    const startedAt = performance.now();
    const summary = await summarizeChunk(combined, false);
    console.log(
      `Summarized to ${summary.length} chars in ${((performance.now() - startedAt) / 1000).toFixed(1)}s:\n${summary}`,
    );
    return summary;
  }

  // Too long for one chunk - split and summarize each chunk
  const chunks = chunkMessages(messages, MAX_SUMMARIZER_INPUT_CHARS);
  console.log(
    `Conversation too long (${combined.length} chars), splitting into ${chunks.length} chunks...`,
  );

  const chunkSummaries: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkText = chunk.join("\n\n---\n\n");
    console.log(
      `Summarizing chunk ${i + 1}/${chunks.length} (${chunkText.length} chars)...`,
    );

    const startedAt = performance.now();
    try {
      const summary = await summarizeChunk(chunkText, true);
      chunkSummaries.push(summary);
      console.log(
        `Chunk ${i + 1} summarized to ${summary.length} chars in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
      );
    } catch (e) {
      console.error(`Failed to summarize chunk ${i + 1}:`, e);
      // Fall back to truncation for this chunk
      chunkSummaries.push(chunkText.slice(0, 5000));
    }
  }

  // Combine all chunk summaries
  return combineSummaries(chunkSummaries);
}

export async function ensureSummarizeModel(): Promise<void> {
  try {
    const response = await fetchWithRetry(
      `${config.ollama.url}/api/show`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: SUMMARIZE_MODEL }),
      },
      "ensureSummarizeModel",
    );

    if (!response.ok) {
      console.log(`Pulling summarization model ${SUMMARIZE_MODEL}...`);
      await fetchWithRetry(
        `${config.ollama.url}/api/pull`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: SUMMARIZE_MODEL }),
        },
        "pullSummarizeModel",
      );
    }
  } catch (e) {
    console.error("Failed to ensure summarization model:", e);
  }
}
