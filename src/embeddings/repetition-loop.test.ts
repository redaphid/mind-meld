import { describe, it, expect } from "vitest";
import {
  isRepetitionLoop,
  longestRepeatedRun,
  LOOP_MIN_REPEATED_WINDOWS,
} from "./repetition-loop.js";

const distinctWords = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

describe("isRepetitionLoop", () => {
  it("flags a summary that re-emits the same clause until the token cap", () => {
    const clause = distinctWords(12, "clause");
    const looped = `${distinctWords(200, "intro")} ${Array(40).fill(clause).join(" ")}`;
    expect(isRepetitionLoop(looped)).toBe(true);
  });

  it("flags a paragraph re-emitted verbatim far from where it first appeared", () => {
    const paragraph = distinctWords(170, "para");
    const text = `${paragraph} ${distinctWords(900, "middle")} ${paragraph}`;
    expect(isRepetitionLoop(text)).toBe(true);
  });

  it("passes an honest summary that restates one sentence", () => {
    const sentence = distinctWords(35, "restated");
    const text = `${sentence} ${distinctWords(600, "body")} ${sentence}`;
    expect(isRepetitionLoop(text)).toBe(false);
  });

  it("passes many short repeated phrases that never form one long copy", () => {
    const text = Array.from(
      { length: 120 },
      (_, i) => `the queue drained in ${i} seconds after step ${i}`,
    ).join(". ");
    expect(isRepetitionLoop(text)).toBe(false);
  });

  it("puts the cut exactly at the threshold", () => {
    const run = (windows: number) => {
      const block = distinctWords(windows + 5, "b");
      return `${block} ${distinctWords(50, "gap")} ${block}`;
    };
    expect(longestRepeatedRun(run(LOOP_MIN_REPEATED_WINDOWS))).toBe(
      LOOP_MIN_REPEATED_WINDOWS,
    );
    expect(isRepetitionLoop(run(LOOP_MIN_REPEATED_WINDOWS))).toBe(true);
    expect(isRepetitionLoop(run(LOOP_MIN_REPEATED_WINDOWS - 1))).toBe(false);
  });
});
