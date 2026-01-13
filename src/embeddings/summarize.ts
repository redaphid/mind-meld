import { config } from '../config.js';

const SUMMARIZE_MODEL = process.env.SUMMARIZE_MODEL ?? 'qwen3:8b';
const MAX_CHARS_BEFORE_SUMMARIZE = 8000;
// qwen3:8b has 40k token context (~160k chars), use most of it
// Leave room for prompt template and output
const MAX_CHUNK_CHARS = 100000;
// Allow up to 6000 tokens (~24k chars) for summary output
const MAX_SUMMARY_TOKENS = 6000;

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

// Summarize a single chunk of text
async function summarizeChunk(text: string, isChunkOfMany: boolean): Promise<string> {
  const contextNote = isChunkOfMany
    ? 'This is one chunk of a larger conversation. Preserve all technical details for later combination.'
    : '';

  const prompt = `You are summarizing a coding conversation between a user and an AI assistant.
${contextNote}

Create a COMPREHENSIVE summary that preserves:
- All file paths, function names, class names, and variable names mentioned
- Error messages and their solutions
- Key decisions and their rationale
- Code changes made (what was added, modified, removed)
- Technical patterns and approaches used
- Commands executed and their outcomes
- Any important context about the project structure

Be thorough - this summary will be used for semantic search to find relevant conversations later.
Include specific technical details, not just high-level descriptions.
Output only the summary, no preamble or meta-commentary.

CONVERSATION:
${text}

DETAILED SUMMARY:`;

  const response = await fetch(`${config.ollama.url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  });

  if (!response.ok) {
    console.error(`Summarization failed: ${response.status}`);
    throw new Error(`Summarization failed: ${response.status}`);
  }

  const result = (await response.json()) as OllamaGenerateResponse;

  // Clean up qwen3's thinking tags if present
  let summary = result.response;
  summary = summary.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  return summary;
}

// Combine multiple summaries into one
async function combineSummaries(summaries: string[]): Promise<string> {
  const combined = summaries.join('\n\n---\n\n');

  // If combined summaries are short enough, return as-is
  if (combined.length <= MAX_CHARS_BEFORE_SUMMARIZE) {
    return combined;
  }

  // If combined summaries fit in one chunk, summarize them
  if (combined.length <= MAX_CHUNK_CHARS) {
    console.log(`Combining ${summaries.length} chunk summaries (${combined.length} chars)...`);

    const prompt = `You are combining multiple conversation summaries into a single comprehensive summary.
Each section below is a summary from a different part of the same conversation.

Merge them into ONE coherent summary that:
- Preserves ALL technical details from each section
- Maintains chronological flow where relevant
- Removes redundancy while keeping all unique information
- Keeps all file paths, function names, error messages, and code changes

Output only the combined summary, no preamble.

SUMMARIES TO COMBINE:
${combined}

COMBINED SUMMARY:`;

    const response = await fetch(`${config.ollama.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    });

    if (!response.ok) {
      // Fall back to concatenation
      return combined.slice(0, MAX_CHARS_BEFORE_SUMMARIZE * 3);
    }

    const result = (await response.json()) as OllamaGenerateResponse;
    let summary = result.response;
    summary = summary.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    console.log(`Combined to ${summary.length} chars`);
    return summary;
  }

  // Combined summaries are too long - recursively chunk and summarize
  console.log(`Combined summaries too long (${combined.length} chars), chunking recursively...`);
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

export async function summarizeConversation(messages: string[]): Promise<string> {
  const combined = messages.join('\n\n---\n\n');

  // If short enough, no summarization needed
  if (combined.length <= MAX_CHARS_BEFORE_SUMMARIZE) {
    return combined;
  }

  // If fits in one chunk, summarize directly
  if (combined.length <= MAX_CHUNK_CHARS) {
    console.log(`Summarizing conversation (${combined.length} chars)...`);
    const summary = await summarizeChunk(combined, false);
    console.log(`Summarized to ${summary.length} chars`);
    return summary;
  }

  // Too long for one chunk - split and summarize each chunk
  const chunks = chunkMessages(messages, MAX_CHUNK_CHARS);
  console.log(
    `Conversation too long (${combined.length} chars), splitting into ${chunks.length} chunks...`
  );

  const chunkSummaries: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkText = chunk.join('\n\n---\n\n');
    console.log(`Summarizing chunk ${i + 1}/${chunks.length} (${chunkText.length} chars)...`);

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
    const response = await fetch(`${config.ollama.url}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: SUMMARIZE_MODEL }),
    });

    if (!response.ok) {
      console.log(`Pulling summarization model ${SUMMARIZE_MODEL}...`);
      await fetch(`${config.ollama.url}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: SUMMARIZE_MODEL }),
      });
    }
  } catch (e) {
    console.error('Failed to ensure summarization model:', e);
  }
}
