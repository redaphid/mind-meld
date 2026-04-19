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
// qwen3:8b has 40k token context (~160k chars), use most of it
// Leave room for prompt template and output
const MAX_CHUNK_CHARS = 100000;
// Cap at bge-m3's 8192-token context — summaries longer than this get truncated
// at embed time, so generating more is wasted compute.
const MAX_SUMMARY_TOKENS = 8192;
const MIN_SUMMARY_CHARS = 500;

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

// Summarize a single chunk of text
async function summarizeChunk(
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
        options: {
          temperature: 0.3,
          num_predict: MAX_SUMMARY_TOKENS,
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

  // Clean up qwen3's thinking tags if present
  let summary = result.response;
  summary = summary.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  if (summary.length < MIN_SUMMARY_CHARS) {
    throw new Error(
      `Summary too short (${summary.length} chars < ${MIN_SUMMARY_CHARS}); likely prompt-injected or refused`,
    );
  }

  return summary;
}

// Combine multiple summaries into one
async function combineSummaries(summaries: string[]): Promise<string> {
  const combined = summaries.join("\n\n---\n\n");

  // If combined summaries are short enough, return as-is
  if (combined.length <= MAX_CHARS_BEFORE_SUMMARIZE) {
    return combined;
  }

  // If combined summaries fit in one chunk, summarize them
  if (combined.length <= MAX_CHUNK_CHARS) {
    console.log(
      `Combining ${summaries.length} chunk summaries (${combined.length} chars)...`,
    );

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
            options: {
              temperature: 0.3,
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
    let summary = result.response;
    summary = summary.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    console.log(`Combined to ${summary.length} chars`);
    return summary;
  }

  // Combined summaries are too long - recursively chunk and summarize
  console.log(
    `Combined summaries too long (${combined.length} chars), chunking recursively...`,
  );
  return summarizeConversation(summaries);
}

// Split messages into chunks that fit within context window
function chunkMessages(messages: string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentLength = 0;

  for (const message of messages) {
    const messageLength = message.length + 10; // Account for separator

    if (currentLength + messageLength > maxChars && currentChunk.length > 0) {
      // Start a new chunk
      chunks.push(currentChunk);
      currentChunk = [message];
      currentLength = messageLength;
    } else {
      currentChunk.push(message);
      currentLength += messageLength;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

export async function summarizeConversation(
  messages: string[],
): Promise<string> {
  const combined = messages.join("\n\n---\n\n");

  // If short enough, no summarization needed
  if (combined.length <= MAX_CHARS_BEFORE_SUMMARIZE) {
    return combined;
  }

  // If fits in one chunk, summarize directly
  if (combined.length <= MAX_CHUNK_CHARS) {
    console.log(`Summarizing conversation (${combined.length} chars)...`);
    const summary = await summarizeChunk(combined, false);
    console.log(`Summarized to ${summary.length} chars:\n${summary}`);
    return summary;
  }

  // Too long for one chunk - split and summarize each chunk
  const chunks = chunkMessages(messages, MAX_CHUNK_CHARS);
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

    try {
      const summary = await summarizeChunk(chunkText, true);
      chunkSummaries.push(summary);
      console.log(`Chunk ${i + 1} summarized to ${summary.length} chars`);
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
