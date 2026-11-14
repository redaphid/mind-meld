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
    expect(summaries.slice(0, -1)).toEqual([PADDED.trim(), PADDED.trim()]);
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

describe("persistSessionChunks bookkeeping", () => {
  const big = "x".repeat(CHUNK_SIZE_CHARS - 50);
  const longSession = [
    { id: 1, role: "user", content_text: big },
    { id: 2, role: "assistant", content_text: big },
  ];
  const ok = (response: string) =>
    ({ ok: true, status: 200, json: async () => ({ response, done: true, prompt_eval_count: 100 }) }) as unknown as Response;

  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(async (sql: string) =>
      String(sql).includes("RETURNING id") ? { rows: [{ id: 7 }] } : { rows: [] },
    );
    vi.stubGlobal("fetch", vi.fn(async () => ok("A real summary of what this chunk did. ".repeat(5))));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds no middle layer for a session that fits one chunk", async () => {
    expect(await persistSessionChunks(1, [])).toBeNull();
    expect(await persistSessionChunks(1, [{ id: 1, role: "user", content_text: "short" }])).toBeNull();
    expect(await persistSessionChunks(1, [{ id: 1, role: "user", content_text: "z".repeat(20000) }])).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("replaces a session's earlier chunks in Chroma and Postgres", async () => {
    const { deleteByIds } = await import("../db/chroma.js");
    query.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith("SELECT id FROM session_chunks")) return { rows: [{ id: 3 }, { id: 4 }] };
      return String(sql).includes("RETURNING id") ? { rows: [{ id: 7 }] } : { rows: [] };
    });
    await persistSessionChunks(5, longSession);
    expect(vi.mocked(deleteByIds)).toHaveBeenCalledWith(expect.any(String), ["chunk-3", "chunk-4"]);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith("DELETE FROM session_chunks"))).toBe(true);
  });

  it("keeps the row but records no vector when embedding fails", async () => {
    const { generateEmbeddings } = await import("./ollama.js");
    vi.mocked(generateEmbeddings).mockResolvedValue([null]);
    const persisted = await persistSessionChunks(6, longSession);
    expect(persisted).toHaveLength(2);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO embeddings"))).toBe(false);
  });

  it("skips a chunk whose summary fails instead of storing anything for it", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ok("<done>COMPLETE</done>"));
    const persisted = await persistSessionChunks(8, longSession);
    expect(persisted).toHaveLength(1);
  });
});
