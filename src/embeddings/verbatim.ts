// A session at or below the verbatim threshold keeps its transcript as its
// summary. batch.ts formats each line as "[ROLE]: text", so a summary that opens
// that way is the transcript itself, not a description of it. health.ts uses
// the pattern in SQL; isVerbatimTranscript is the same rule in TypeScript.
export const VERBATIM_TRANSCRIPT_PATTERN = String.raw`^\[[A-Z_]+\]:`;

const VERBATIM_TRANSCRIPT = new RegExp(VERBATIM_TRANSCRIPT_PATTERN);

export const isVerbatimTranscript = (summary: string): boolean =>
  VERBATIM_TRANSCRIPT.test(summary);
