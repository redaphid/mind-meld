import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  summarizeChunk,
  TruncationError,
} from "../../src/embeddings/summarize.js";

const corpus = readFileSync("tmp/bench-corpus.txt", "utf8");

const okChunk = corpus.slice(0, 28000);
const summary = await summarizeChunk(okChunk, true);
assert(summary.length > 200, `summary too short: ${summary.length}`);
console.log(`28k chunk OK: ${summary.length} chars — ${summary.slice(0, 120)}`);

try {
  await summarizeChunk(corpus.slice(0, 90000), true);
  assert.fail("expected TruncationError for 90k input");
} catch (e) {
  assert(e instanceof TruncationError, `wrong error: ${e}`);
  console.log(
    `90k input correctly threw: ${(e as Error).message.slice(0, 100)}`,
  );
}
