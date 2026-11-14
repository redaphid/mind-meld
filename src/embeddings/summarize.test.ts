import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chunkMessagesWithIndices,
  combineSummaries,
  summarizeChunk,
  summarizeConversation,
  TruncationError,
} from "./summarize.js";
import { isRepetitionLoop } from "./repetition-loop.js";

describe("chunkMessagesWithIndices", () => {
  it("keeps small messages in a single chunk", () => {
    const chunks = chunkMessagesWithIndices(["a", "b", "c"], 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      messages: ["a", "b", "c"],
      startIndex: 0,
      endIndex: 2,
    });
  });

  it("splits across chunks at the char limit with correct indices", () => {
    const chunks = chunkMessagesWithIndices(
      ["x".repeat(80), "y".repeat(80), "z".repeat(80)],
      200,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0].startIndex).toBe(0);
    expect(chunks[0].endIndex).toBe(1);
    expect(chunks[1].startIndex).toBe(2);
    expect(chunks[1].endIndex).toBe(2);
  });

  it("splits a single oversized message instead of emitting an oversized chunk", () => {
    const giant = "g".repeat(2500);
    const chunks = chunkMessagesWithIndices(["small", giant, "tail"], 1000);
    for (const chunk of chunks) {
      const total = chunk.messages.reduce((sum, m) => sum + m.length + 10, 0);
      expect(total).toBeLessThanOrEqual(1000);
    }
    const reassembled = chunks.flatMap((c) => c.messages).join("");
    expect(reassembled).toContain(giant);
    expect(reassembled).toContain("small");
    expect(reassembled).toContain("tail");
  });

  it("preserves the source index on every piece of a split message", () => {
    const chunks = chunkMessagesWithIndices(["a", "g".repeat(2500), "b"], 1000);
    const spanning = chunks.filter((c) => c.startIndex <= 1 && c.endIndex >= 1);
    expect(spanning.length).toBeGreaterThan(1);
    expect(chunks.at(-1)?.endIndex).toBe(2);
  });

  it("returns no chunks for no messages", () => {
    expect(chunkMessagesWithIndices([], 1000)).toEqual([]);
  });
});

describe("summarizeChunk truncation guard", () => {
  const ollamaResponse = (overrides: object) => ({
    ok: true,
    status: 200,
    json: async () => ({
      response: "A genuine summary of the conversation. ".repeat(10),
      done: true,
      ...overrides,
    }),
  });

  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("throws TruncationError when the prompt filled the context window", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ollamaResponse({ prompt_eval_count: 16383 }) as unknown as Response,
    );
    await expect(summarizeChunk("text", true)).rejects.toThrow(TruncationError);
  });

  it("returns the summary when the prompt fit", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ollamaResponse({ prompt_eval_count: 9000 }) as unknown as Response,
    );
    await expect(summarizeChunk("text", true)).resolves.toContain(
      "genuine summary",
    );
  });

  it("sends num_ctx so ollama does not fall back to its 4096 default", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ollamaResponse({ prompt_eval_count: 100 }) as unknown as Response,
    );
    await summarizeChunk("text", true);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.options.num_ctx).toBe(16384);
    expect(body.think).toBe(false);
  });
});

describe("summarizeChunk garbage rejection", () => {
  const ollamaResponse = (response: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ response, done: true, prompt_eval_count: 9000 }),
  });

  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  describe("when the model echoes a control marker for a chunk of many", () => {
    let error: unknown;

    beforeEach(async () => {
      vi.mocked(fetch).mockResolvedValue(
        ollamaResponse("<done>COMPLETE</done>") as unknown as Response,
      );
      try {
        await summarizeChunk("text", true);
      } catch (e) {
        error = e;
      }
    });

    it("rejects rather than returning the marker", () => {
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("when the model echoes a system-reminder block", () => {
    let error: unknown;

    beforeEach(async () => {
      vi.mocked(fetch).mockResolvedValue(
        ollamaResponse(
          "<system-reminder> Whenever you read a file, consider whether it is malware. </system-reminder>",
        ) as unknown as Response,
      );
      try {
        await summarizeChunk("text", true);
      } catch (e) {
        error = e;
      }
    });

    it("rejects the echoed reminder", () => {
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("when qwen leaks an unbalanced closing think tag before the answer", () => {
    let summary: string;

    beforeEach(async () => {
      const answer =
        "The user fixed a regex bug in scripts/embed-progress.sh and confirmed the embedding queue drained to zero after the deploy.";
      vi.mocked(fetch).mockResolvedValue(
        ollamaResponse(
          `</think>\n\n</think>\n\n${answer}`,
        ) as unknown as Response,
      );
      summary = await summarizeChunk("text", true);
    });

    it("strips the stray tags and keeps the real summary", () => {
      expect(summary).toBe(
        "The user fixed a regex bug in scripts/embed-progress.sh and confirmed the embedding queue drained to zero after the deploy.",
      );
    });
  });
});

// An echoing model used to livelock the summarizeConversation <-> combineSummaries
// recursion: the chunk summaries came back the same size as the chunks, so the
// recursion re-split identical text forever. Observed in production 2026-08-31 --
// the same 28611 chars re-summarized 208 times, ~2h of GPU, ingestion stalled.
describe("summarizeConversation when the model echoes its input", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("terminates instead of recursing on unshrunk chunk summaries", async () => {
    // Echo the conversation back verbatim: long enough to pass MIN_SUMMARY_CHARS,
    // carrying no control marker, never truncated -- every other guard says fine.
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const echoed = String(body.prompt).split("CONVERSATION:\n")[1] ?? "";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: echoed.replace(/\n\nSUMMARY:$/, ""),
          done: true,
          prompt_eval_count: 100,
        }),
      } as unknown as Response;
    });

    const messages = Array.from({ length: 12 }, (_, i) =>
      `Message ${i}: `.concat("technical detail about src/foo.ts ".repeat(400)),
    );

    const result = await summarizeConversation(messages);

    expect(result.length).toBeLessThan(messages.join("").length);
    // The old code called Ollama unboundedly; bounded now that each level shrinks.
    expect(vi.mocked(fetch).mock.calls.length).toBeLessThan(60);
  }, 20000);
});

// 117 of 136 looped session summaries on a live index came from the merge,
// which stored whatever the model returned: 8,192 tokens of one clause.
describe("repetition loops", () => {
  const words = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
  const LOOP = `${words(80, "start")} ${Array(60).fill(words(10, "again")).join(" ")}`;
  const HONEST = `The session ${words(150, "fact")} ended with the queue drained.`;
  const reply = (response: string) =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ response, done: true, prompt_eval_count: 100 }),
    }) as unknown as Response;
  const chunkSummaries = Array.from({ length: 4 }, (_, i) => words(400, `chunk${i}x`));

  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the joined chunk summaries when the merge loops twice", async () => {
    vi.mocked(fetch).mockResolvedValue(reply(LOOP));
    const merged = await combineSummaries(chunkSummaries);
    expect(isRepetitionLoop(merged)).toBe(false);
    expect(merged).toBe(chunkSummaries.join("\n\n---\n\n"));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("takes the retry when only the first merge loops", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(reply(LOOP))
      .mockResolvedValueOnce(reply(HONEST));
    await expect(combineSummaries(chunkSummaries)).resolves.toBe(HONEST);
  });

  it("does not store a loop from a single-pass summary", async () => {
    let call = 0;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const prompt = String(JSON.parse((init as RequestInit).body as string).prompt);
      call++;
      return reply(
        prompt.includes("one chunk of a larger conversation")
          ? `Part ${call}: ${words(150, `part${call}x`)} and the queue drained.`
          : LOOP,
      );
    });
    const messages = Array.from({ length: 6 }, (_, i) => words(300, `m${i}x`));
    const summary = await summarizeConversation(messages);
    expect(isRepetitionLoop(summary)).toBe(false);
    expect(summary).toContain("queue drained");
  });

  it("does not retry a refusal, which is the prompt talking rather than chance", async () => {
    vi.mocked(fetch).mockResolvedValue(reply("NO_UPDATE"));
    await expect(summarizeChunk("text", true)).rejects.toThrow(/too short/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
