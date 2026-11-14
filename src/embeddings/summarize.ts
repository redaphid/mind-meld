import { config } from "../config.js";
import { withOllamaGate } from "./ollama-gate.js";
import { isRepetitionLoop, longestRepeatedRun } from "./repetition-loop.js";

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
      const response = await withOllamaGate(() =>
        fetch(url, {
          ...options,
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
// Floor for every summary — chunk summaries are embedded into convo-chunks and
// returned as chunk-tier search hits, so they must clear the same bar as the
// final summary. Rejects refusals / near-empty garbage ("<done>", "The"), not
// genuinely terse but real summaries.
const MIN_SUMMARY_CHARS = 100;
// Agentic transcripts carry markers (<done>COMPLETE</done>, <review>PASS</review>,
// <system-reminder>…); qwen sometimes echoes one instead of summarizing. A real
// prose summary (prompt forbids preamble) never opens with a tag.
const CONTROL_MARKER = /^<[a-z]/i;

// Belt-and-suspenders against qwen3 reasoning. `think: false` in the request
// body already suppresses it on current Ollama, but the `/no_think` soft switch
// in the prompt is a cheap guard if a model/version change ever re-enables it.
// It is NOT a latency fix — measured summary cost is dominated by prompt prefill
// on a contended GPU, not by generated tokens. qwen3 may still emit an empty
// <think></think> pair, so stripThinking stays as a net: the answer follows the
// final </think>, so slice past it, then scrub any stray opener/closer.
const NO_THINK = "/no_think";
const stripThinking = (text: string): string => {
  const lastClose = text.lastIndexOf("</think>");
  const body =
    lastClose === -1 ? text : text.slice(lastClose + "</think>".length);
  return body.replace(/<\/?think>/g, "").trim();
};

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

// How a session's text becomes the text that is stored, shown and embedded.
// One value per style keeps the threshold and both prompts together, so a
// caller can never pair one style's chunk prompt with another's merge prompt.
export type SummaryStyle = {
  // Joined transcripts at or under this many chars are stored verbatim.
  verbatimAtOrBelowChars: number;
  chunkPrompt: (text: string, isChunkOfMany: boolean) => string;
  mergePrompt: (combined: string) => string;
};

const CODING_STYLE: SummaryStyle = {
  verbatimAtOrBelowChars: 8000,
  chunkPrompt: (text, isChunkOfMany) => {
    const contextNote = isChunkOfMany
      ? "This is one chunk of a larger conversation. Preserve all technical details for later combination."
      : "";
    return `${NO_THINK}
You are writing a dense technical summary of a coding conversation. The summary is used for semantic search, so it must describe what actually happened — not reproduce it.

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
  },
  mergePrompt: (combined) => `${NO_THINK}
Merge the following chunk summaries of a single coding conversation into one coherent summary.

Rules:
- Preserve concrete nouns from each chunk (file paths, function names, error messages, decisions) inline as prose.
- Remove redundancy — if two chunks mention the same thing, say it once.
- Maintain chronological flow where it matters.
- NO code blocks, NO triple backticks, NO verbatim output, NO invented examples.
- Output the merged summary only. No preamble, no "Combined Summary:" heading.

CHUNK SUMMARIES:
${combined}

MERGED SUMMARY:`,
};

// The model's answer was produced but is not a summary. Distinct from a
// transport failure: retrying the same prompt can succeed, and the caller may
// hold an honest fallback text.
class SummaryRejectedError extends Error {
  constructor(
    readonly kind: "control-marker" | "too-short" | "loop",
    message: string,
  ) {
    super(message);
    this.name = "SummaryRejectedError";
  }
}

const generate = async (
  prompt: string,
  numPredict: number,
  label: string,
): Promise<string> => {
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
          num_predict: numPredict,
        },
      }),
    },
    label,
  );

  if (!response.ok) {
    console.error(`Summarization failed: ${response.status}`);
    throw new Error(`Summarization failed: ${response.status}`);
  }

  const result = (await response.json()) as OllamaGenerateResponse;
  assertNotTruncated(result, label);
  return rejectNonSummary(stripThinking(result.response));
};

// Sampling at 0.3 makes a loop unlikely to recur on the same prompt, so one
// fresh attempt is worth its cost. A refusal or an echoed marker is the prompt
// talking, not chance, so those are not retried.
const retryIfLooped = async (attempt: () => Promise<string>) => {
  try {
    return await attempt();
  } catch (e) {
    if (!(e instanceof SummaryRejectedError) || e.kind !== "loop") throw e;
    console.warn(`Retrying once after a repetition loop: ${e.message}`);
    return attempt();
  }
};

// Summarize a single chunk of text
export async function summarizeChunk(
  text: string,
  isChunkOfMany: boolean,
  maxTokens?: number,
  style: SummaryStyle = CODING_STYLE,
): Promise<string> {
  const prompt = style.chunkPrompt(text, isChunkOfMany);
  const numPredict =
    maxTokens ??
    (isChunkOfMany ? MAX_CHUNK_SUMMARY_TOKENS : MAX_SUMMARY_TOKENS);
  return retryIfLooped(() => generate(prompt, numPredict, "summarizeChunk"));
}

const rejectNonSummary = (summary: string): string => {
  if (CONTROL_MARKER.test(summary)) {
    console.error(
      `Rejected summary (control marker): ${JSON.stringify(summary)}`,
    );
    throw new SummaryRejectedError(
      "control-marker",
      `Summary is a control marker (${JSON.stringify(summary.slice(0, 40))}); model echoed instead of summarizing`,
    );
  }

  if (summary.length < MIN_SUMMARY_CHARS) {
    console.error(
      `Rejected summary (${summary.length} chars): ${JSON.stringify(summary)}`,
    );
    throw new SummaryRejectedError(
      "too-short",
      `Summary too short (${summary.length} chars < ${MIN_SUMMARY_CHARS}); likely prompt-injected or refused`,
    );
  }

  if (isRepetitionLoop(summary)) {
    throw new SummaryRejectedError(
      "loop",
      `Summary is a repetition loop (${summary.length} chars, ${longestRepeatedRun(summary)} repeated windows)`,
    );
  }

  return summary;
};

// A chunk this small is its own best summary. On a live index (2026-11-13),
// 240 of 245 stored summaries of chunks under 2,000 chars were longer than the
// chunk itself (30 of 30 under 500 chars, median 7x), padded with work the
// chunk never described. Long sessions end in such a remainder chunk.
export const CHUNK_VERBATIM_CHARS = 2000;

// The chunk tier's summary of one chunk. Above the floor, a summary that does
// not come back shorter than its chunk is padding of the same kind, so the
// chunk's own text is kept instead.
export async function summarizeSessionChunk(text: string): Promise<string> {
  if (text.length <= CHUNK_VERBATIM_CHARS) return text;
  const summary = await summarizeChunk(text, true);
  return summary.length < text.length ? summary : text;
}

// Combine multiple summaries into one
// joinIfShort: false when any input is transcript kept verbatim (a small chunk,
// see summarizeSessionChunk). Joined as-is, its [USER]:/[ASSISTANT]: lines
// would become the session summary, which every bad-summary audit flags as
// raw_message_leak or truncated, and a reset would only rebuild it the same.
export async function combineSummaries(
  summaries: string[],
  {
    style = CODING_STYLE,
    joinIfShort = true,
  }: { style?: SummaryStyle; joinIfShort?: boolean } = {},
): Promise<string> {
  const combined = summaries.join("\n\n---\n\n");

  // If combined summaries are short enough, return as-is
  if (joinIfShort && combined.length <= style.verbatimAtOrBelowChars) {
    console.log(
      `SUMMARY-OF-SUMMARIES (${summaries.length} chunk summaries joined as-is, ${combined.length} chars):\n${combined}`,
    );
    return combined;
  }

  // If combined summaries fit in one chunk, summarize them
  if (combined.length <= MAX_SUMMARIZER_INPUT_CHARS) {
    console.log(
      `Combining ${summaries.length} chunk summaries (${combined.length} chars)...`,
    );
    const startedAt = performance.now();

    const prompt = style.mergePrompt(combined);

    let summary: string;
    try {
      summary = assertShrunk(
        combined,
        await retryIfLooped(() =>
          generate(prompt, MAX_SUMMARY_TOKENS, "combineSummaries"),
        ),
      );
    } catch (e) {
      if (e instanceof TruncationError) throw e;
      if (e instanceof SummaryRejectedError || e instanceof NotShrunkError) {
        // The chunk summaries are honest model output already; storing them
        // joined beats storing a loop. 117 of the 136 looped session summaries
        // found 2026-11-13 came from this merge, which had no check at all.
        console.warn(
          `combineSummaries: merge rejected (${e.message}); keeping ${summaries.length} chunk summaries joined`,
        );
        return combined;
      }
      // Fall back to concatenation on persistent failure
      return combined.slice(0, MAX_CHARS_BEFORE_SUMMARIZE * 3);
    }

    console.log(
      `SUMMARY-OF-SUMMARIES (merged ${summaries.length} chunk summaries → ${summary.length} chars in ${((performance.now() - startedAt) / 1000).toFixed(1)}s):\n${summary}`,
    );
    return summary;
  }

  // Combined summaries are too long - recursively chunk and summarize.
  // Termination rests on each chunk summary being strictly smaller than its
  // chunk (assertShrunk in summarizeConversation): combined therefore shrinks at
  // every level, so this cannot re-split identical text forever.
  console.log(
    `Combined summaries too long (${combined.length} chars), chunking recursively...`,
  );
  return summarizeConversation(summaries, style);
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
  style: SummaryStyle = CODING_STYLE,
): Promise<string> {
  const combined = messages.join("\n\n---\n\n");

  // If short enough, no summarization needed
  if (combined.length <= style.verbatimAtOrBelowChars) {
    return combined;
  }

  // If fits in one chunk, summarize directly
  if (combined.length <= MAX_SUMMARIZER_INPUT_CHARS) {
    console.log(`Summarizing conversation (${combined.length} chars)...`);
    const startedAt = performance.now();
    try {
      const summary = await summarizeChunk(combined, false, undefined, style);
      console.log(
        `Summarized to ${summary.length} chars in ${((performance.now() - startedAt) / 1000).toFixed(1)}s:\n${summary}`,
      );
      return summary;
    } catch (e) {
      if (!(e instanceof SummaryRejectedError) || e.kind !== "loop") throw e;
      // Looped twice in one pass. Shorter passes loop less (a runaway fills
      // the room num_predict gives it), and a throw here would leave the
      // session pending, to loop again on every sync cycle.
      // + 10 undoes chunkMessages' per-piece reserve, so this is two passes, not three.
      return summarizeInChunks(messages, Math.ceil(combined.length / 2) + 10, style);
    }
  }

  return summarizeInChunks(messages, MAX_SUMMARIZER_INPUT_CHARS, style);
}

async function summarizeInChunks(
  messages: string[],
  maxChunkChars: number,
  style: SummaryStyle,
): Promise<string> {
  const combined = messages.join("\n\n---\n\n");
  const chunks = chunkMessages(messages, maxChunkChars);
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
      // A chunk summary that is not smaller than its chunk makes the
      // combineSummaries -> summarizeConversation recursion below re-split the
      // identical text forever. Observed 2026-08-31: qwen echoed a 14798-char
      // chunk verbatim, and the pair recursed on the same 28611 chars 208 times
      // (~2h of GPU) while ingestion stalled behind it. Reject here so the
      // catch's truncation fallback runs and the next level is strictly smaller.
      const summary = assertShrunk(
        chunkText,
        await summarizeChunk(chunkText, true, undefined, style),
      );
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
  return combineSummaries(chunkSummaries, { style });
}

// A summary that isn't smaller than its input is not a summary. qwen3 at 0.3 falls
// into repetition loops on some inputs and rambles to the num_predict cap — observed
// 2026-07-28 merging 19,499 chars of chunk summaries into 50,831 chars of the same
// clause repeated. Callers rely on this shrinking, so refuse rather than hand back
// something they'll only have to re-summarize.
class NotShrunkError extends Error {}

const assertShrunk = (input: string, summary: string) => {
  if (summary.length < input.length) return summary;
  throw new NotShrunkError(
    `Summarization did not shrink text (${input.length} → ${summary.length} chars); model likely looped`,
  );
};

// summarizeConversation returns its input verbatim below MAX_CHARS_BEFORE_SUMMARIZE,
// which is useless to a caller that needs the text to get *smaller*: bge-m3 rejects on
// tokens, not characters, and id-dense text can blow the 8192-token window in 6k chars.
// This always runs the model, so the output is always shorter than the input.
// assertShrunk alone can only detect a runaway summary after paying for it, and on
// the single-chunk path there's no joined-chunks fallback to fall back to. Capping
// num_predict at roughly a quarter of the input's token count makes the runaway
// impossible instead: prose is ~4 chars/token, so input/16 tokens cannot outrun
// input chars no matter how badly the model loops.
const shrinkBudget = (chars: number) => Math.max(256, Math.floor(chars / 16));

export async function shrinkBySummarizing(text: string): Promise<string> {
  if (text.length <= MAX_SUMMARIZER_INPUT_CHARS) {
    return assertShrunk(
      text,
      await summarizeChunk(text, false, shrinkBudget(text.length)),
    );
  }

  const chunks = chunkMessagesWithIndices([text], MAX_SUMMARIZER_INPUT_CHARS);
  const summaries: string[] = [];
  for (const chunk of chunks) {
    summaries.push(await summarizeChunk(chunk.messages.join(""), true));
  }

  // Joined chunk summaries are always smaller than the original, so they're the
  // safety net when the merge pass loops instead of condensing.
  const joined = summaries.join("\n\n");
  const merged = await combineSummaries(summaries);
  if (merged.length < joined.length) return assertShrunk(text, merged);
  return assertShrunk(text, joined);
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
