import { describe, it, expect } from "vitest";
import { isVerbatimTranscript, VERBATIM_TRANSCRIPT_PATTERN } from "./verbatim.js";

describe("isVerbatimTranscript", () => {
  it.each(["[USER]: hi", "[ASSISTANT]: done", "[TOOL_RESULT]: ok"])("knows %j is a transcript", (summary) => {
    expect(isVerbatimTranscript(summary)).toBe(true);
  });

  it.each(["USER]: hi", "A]: x", "NOTE]: summary text", "The user fixed [USER]: parsing", "[user]: lower"])(
    "knows %j is not",
    (summary) => {
      expect(isVerbatimTranscript(summary)).toBe(false);
    },
  );

  // health.ts quotes this into SQL, so the backslashes must survive as written.
  it("keeps its escapes for the SQL that shares it", () => {
    expect(VERBATIM_TRANSCRIPT_PATTERN).toBe(String.raw`^\[[A-Z_]+\]:`);
  });
});
