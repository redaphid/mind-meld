// How a session's messages become the exact text the summarizer receives.
//
// Deliberately free of database, Chroma and Ollama imports: this is pure string
// assembly, and it is what an offline harness needs. Keeping it separate means a
// test of chunk assembly does not drag a vector-store client into the process.
import { chunkMessagesWithIndices, CHUNK_SIZE_CHARS } from "./summarize.js";

export interface SessionMessage {
  id: number;
  role: string;
  content_text: string;
}

export const formatForSummary = (m: SessionMessage): string =>
  `[${m.role.toUpperCase()}]: ${m.content_text}`;

// The separator between messages inside one chunk. Exported so nothing has to
// restate it — a benchmark or CLI that re-joins messages its own way is
// measuring an input the pipeline never produces.
export const CHUNK_JOIN = "\n\n---\n\n";

// Messages -> the exact chunk texts the summarizer receives. This is the one
// definition of "what a chunk is": production and any offline harness must go
// through it, or they diverge silently and the harness measures nothing real.
export const buildChunkTexts = (messages: SessionMessage[]): string[] =>
  chunkMessagesWithIndices(messages.map(formatForSummary), CHUNK_SIZE_CHARS).map(
    (c) => c.messages.join(CHUNK_JOIN),
  );
