import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const query = vi.fn();
vi.mock("../db/postgres.js", () => ({ query: (...a: unknown[]) => query(...a) }));
vi.mock("../db/chroma.js", () => ({
  upsertEmbeddings: vi.fn(async () => {}),
  deleteByIds: vi.fn(async () => {}),
}));
vi.mock("./ollama.js", () => ({
  generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
}));

const { persistSessionChunks } = await import("./chunks.js");
const { CHUNK_SIZE_CHARS, CHUNK_VERBATIM_CHARS } = await import("./summarize.js");

// What the model does to a few hundred chars of transcript: a confident,
// longer account of work the chunk never described.
const PADDED = "The user refactored the embedding pipeline in src/embeddings/batch.ts, ".repeat(12);

const storedChunkSummaries = () =>
  query.mock.calls
    .filter(([sql]) => String(sql).includes("INSERT INTO session_chunks"))
    .map(([, params]) => (params as unknown[])[4] as string);

describe("persistSessionChunks on a long session's small remainder", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(async (sql: string) =>
      String(sql).includes("RETURNING id") ? { rows: [{ id: 1 }] } : { rows: [] },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ response: PADDED, done: true, prompt_eval_count: 100 }),
      })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stores a chunk under the floor as its own text, without asking the model", async () => {
    const big = "x".repeat(CHUNK_SIZE_CHARS - 20);
    const messages = [
      { id: 1, role: "user", content_text: big },
      { id: 2, role: "assistant", content_text: big },
      { id: 3, role: "user", content_text: "thanks, that fixed it" },
    ];

    await persistSessionChunks(42, messages);

    const summaries = storedChunkSummaries();
    const last = summaries.at(-1) ?? "";
    expect(last.length).toBeLessThanOrEqual(CHUNK_VERBATIM_CHARS);
    expect(last).toContain("thanks, that fixed it");
    expect(last).not.toContain("refactored the embedding pipeline");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("keeps a chunk's own text when the model's summary comes back longer", async () => {
    const mid = "y".repeat(CHUNK_VERBATIM_CHARS + 50);
    const big = "x".repeat(CHUNK_SIZE_CHARS - 20);
    const messages = [
      { id: 1, role: "user", content_text: big },
      { id: 2, role: "assistant", content_text: mid },
    ];
    vi.mocked(fetch).mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ response: PADDED.repeat(4), done: true, prompt_eval_count: 100 }),
        }) as unknown as Response,
    );

    await persistSessionChunks(43, messages);

    const last = storedChunkSummaries().at(-1) ?? "";
    expect(last).toContain("y".repeat(CHUNK_VERBATIM_CHARS));
    expect(last).not.toContain("refactored the embedding pipeline");
  });
});
