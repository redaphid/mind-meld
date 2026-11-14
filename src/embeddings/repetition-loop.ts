// A repetition loop is generated text that starts copying itself: qwen3 at
// temperature 0.3 sometimes re-emits an earlier passage, or cycles one clause,
// until num_predict runs out. Measured on the live index 2026-11-13: an honest
// summary's longest self-copy is 0 windows at the median, restating one sentence
// gives 30-40, and from about 100 upward every inspected case was degenerate
// (a paragraph re-emitted, a path list cycling). Counts were stable across
// thresholds (315 at 100, 299 at 150, 293 at 200 of 3,088 generated summaries),
// so the cut sits in an empty valley, not on a slope.
//
// This is the one definition. The summarizer refuses its own output with it and
// the health tool counts stored summaries with it, so "looped" means the same
// thing to the code that writes a summary and the code that audits it.

const WINDOW_WORDS = 6;

// Consecutive word windows, each already seen earlier in the text. 150 windows
// is about 155 words copied verbatim from earlier in the same summary.
export const LOOP_MIN_REPEATED_WINDOWS = 150;

// The shortest text that can hold such a run: every word takes at least one
// character and one separator. Lets a scan skip rows that cannot qualify.
export const LOOP_MIN_CHARS =
  2 * (LOOP_MIN_REPEATED_WINDOWS + WINDOW_WORDS) - 1;

export const longestRepeatedRun = (text: string): number => {
  const words = text.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  let run = 0;
  let longest = 0;
  for (let i = 0; i + WINDOW_WORDS <= words.length; i++) {
    const window = words.slice(i, i + WINDOW_WORDS).join(" ");
    if (seen.has(window)) {
      run++;
      if (run > longest) longest = run;
      continue;
    }
    seen.add(window);
    run = 0;
  }
  return longest;
};

export const isRepetitionLoop = (text: string): boolean =>
  text.length >= LOOP_MIN_CHARS &&
  longestRepeatedRun(text) >= LOOP_MIN_REPEATED_WINDOWS;
