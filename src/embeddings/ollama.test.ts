import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isRecoverableEmbedError,
  isOversizeEmbedError,
  isNaNEmbedError,
  retryAfterMs,
  getInteractiveOllamaClient,
  getOllamaClient,
} from "./ollama.js";
import { config } from "../config.js";

// Oversize and NaN are both recoverable but need opposite rewrites — summarize to
// shed tokens vs. rephrase to change wording at the same length. Confusing the two
// sends a too-long text to the rephraser, which returns something just as long.
describe("embed failure classification", () => {
  let error: any;

  describe("when ollama rejects the input for context length", () => {
    beforeEach(() => {
      error = { error: "the input length exceeds the context length" };
    });

    it("classifies it as oversize", () => {
      expect(isOversizeEmbedError(error)).toBe(true);
    });

    it("does not classify it as NaN", () => {
      expect(isNaNEmbedError(error)).toBe(false);
    });
  });

  describe("when the model returns a NaN embedding", () => {
    beforeEach(() => {
      error = new Error("NaN in embedding");
    });

    it("classifies it as NaN", () => {
      expect(isNaNEmbedError(error)).toBe(true);
    });

    it("does not classify it as oversize", () => {
      expect(isOversizeEmbedError(error)).toBe(false);
    });
  });

  describe("when ollama is unreachable", () => {
    beforeEach(() => {
      error = new Error("fetch failed");
      error.code = "ECONNREFUSED";
    });

    it("classifies it as neither oversize nor NaN", () => {
      expect(isRecoverableEmbedError(error)).toBe(false);
    });
  });
});

// This predicate is the cork-remover. It sat unexercised from 2026-01 to
// 2026-07-20, matching only "NaN"; the first context-length 400 to arrive
// rethrew, and because the queue is ORDER BY id over un-embedded rows, that
// one message stalled all 29,217 behind it for eight days. Adversarial cases
// below are the shapes that actually reached it.
describe("isRecoverableEmbedError", () => {
  it("recovers the context-length 400 that deadlocked the pipeline", () => {
    // Verbatim body from ollama 0.32.4 /api/embed on message 37058983
    const error = { error: "the input length exceeds the context length" };
    expect(isRecoverableEmbedError(error)).toBe(true);
  });

  it("recovers the same failure when the client wraps it as message", () => {
    const error = new Error("the input length exceeds the context length");
    expect(isRecoverableEmbedError(error)).toBe(true);
  });

  it("recovers the NaN bug it was originally written for", () => {
    expect(isRecoverableEmbedError(new Error("NaN in embedding"))).toBe(true);
    expect(isRecoverableEmbedError({ error: "embedding contains NaN" })).toBe(
      true,
    );
  });

  it("does NOT swallow a connection failure", () => {
    // Retrying per-text cannot fix an unreachable Ollama; it must surface so
    // the tunnel gets fixed instead of every text failing 50 times over.
    const error: any = new Error("fetch failed");
    error.code = "ECONNREFUSED";
    expect(isRecoverableEmbedError(error)).toBe(false);
  });

  it("does NOT swallow a missing model", () => {
    expect(isRecoverableEmbedError({ error: 'model "bge-m3" not found' })).toBe(
      false,
    );
  });

  it("does NOT swallow a timeout", () => {
    const error: any = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    expect(isRecoverableEmbedError(error)).toBe(false);
  });

  it("survives errors with no message or error field", () => {
    expect(isRecoverableEmbedError({})).toBe(false);
    expect(isRecoverableEmbedError(null)).toBe(false);
    expect(isRecoverableEmbedError(undefined)).toBe(false);
  });

  it("matches on either field when the other is absent", () => {
    expect(isRecoverableEmbedError({ message: undefined, error: "NaN" })).toBe(
      true,
    );
    expect(
      isRecoverableEmbedError({
        message: "exceeds the context length",
        error: undefined,
      }),
    ).toBe(true);
  });
});

// A GPU gate in front of Ollama answers 503 + Retry-After while something else
// holds the VRAM. Getting this wrong is not a cosmetic bug: too short and the
// sync busy-loops against a closed gate, too long and one refusal parks a run
// for the gate's entire cooldown.
describe("retryAfterMs", () => {
  const { retryDelayMs, retryMaxDelayMs } = config.ollama;

  describe("when the header is delta-seconds", () => {
    it("waits that long", () => {
      expect(retryAfterMs("30")).toBe(30_000);
    });

    it("clamps a cooldown-length wait to the ceiling", () => {
      // ollama-proxy asks for its full 900s cooldown on a cold start.
      expect(retryAfterMs("900")).toBe(retryMaxDelayMs);
    });

    it("treats zero as unusable rather than retrying instantly", () => {
      expect(retryAfterMs("0")).toBe(retryDelayMs);
    });
  });

  describe("when the header is an HTTP-date", () => {
    it("waits until that moment", () => {
      const at = new Date(Date.now() + 20_000).toUTCString();
      // Whole-second resolution in the header, so allow a second of slack.
      expect(retryAfterMs(at)).toBeGreaterThan(18_000);
      expect(retryAfterMs(at)).toBeLessThanOrEqual(20_000);
    });

    it("falls back when the date has already passed", () => {
      const at = new Date(Date.now() - 60_000).toUTCString();
      expect(retryAfterMs(at)).toBe(retryDelayMs);
    });
  });

  describe("when the header is absent or unparseable", () => {
    it("falls back to the ordinary retry delay", () => {
      expect(retryAfterMs(null)).toBe(retryDelayMs);
      expect(retryAfterMs("")).toBe(retryDelayMs);
      expect(retryAfterMs("soon")).toBe(retryDelayMs);
    });
  });
});

// A search that gave up must not keep the one Ollama slot busy embedding a
// query nobody will read.
describe("the interactive client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cancels the request in flight when its caller aborts", async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_input: unknown, init: RequestInit) => {
      seen = init.signal ?? undefined;
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    });
    const caller = new AbortController();
    const embedding = getInteractiveOllamaClient(caller.signal).embed({ model: "m", input: "q" });
    await vi.waitFor(() => expect(seen).toBeDefined());
    caller.abort(new Error("search-abandoned-heron"));
    await expect(embedding).rejects.toThrow("search-abandoned-heron");
  });

  // ollama-js aborts every request of a client at once, so a shared client
  // would let one abandoned search cancel queued background work too.
  it("frees the slot for background work, and cancels nothing else, when its caller aborts", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", (_input: unknown, init: RequestInit) => {
      calls += 1;
      if (calls === 1)
        return new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        );
      return Promise.resolve(Response.json({ model: "m", embeddings: [[0.5]] }));
    });
    const caller = new AbortController();
    const search = getInteractiveOllamaClient(caller.signal).embed({ model: "m", input: "q" });
    await vi.waitFor(() => expect(calls).toBe(1));
    const background = getOllamaClient().embed({ model: "m", input: "summary" });
    caller.abort(new Error("search-abandoned-wren"));
    await expect(search).rejects.toThrow("search-abandoned-wren");
    await expect(background).resolves.toMatchObject({ embeddings: [[0.5]] });
  });
});

// The GPU gate answers 503 while a game holds the card. Background work must
// wait it out rather than fail and be relaunched straight back into the gate.
describe("the background client", () => {
  const ollama = config.ollama as { retryDelayMs: number; retryMaxDelayMs: number; maxRetries: number };
  const saved = { ...ollama };
  const ok = () => Promise.resolve(Response.json({ model: "m", embeddings: [[0.5]] }));
  const shut = () => Promise.resolve(new Response("gate-shut-plover: a game holds the GPU", { status: 503, headers: { "retry-after": "1" } }));
  beforeEach(() => {
    Object.assign(ollama, { retryDelayMs: 1, retryMaxDelayMs: 1, maxRetries: 3 });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    Object.assign(ollama, saved);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("waits out a shut gate and retries", async () => {
    const responses = [shut, ok];
    const fetch = vi.fn(() => responses.shift()!());
    vi.stubGlobal("fetch", fetch);
    await expect(getOllamaClient().embed({ model: "m", input: "summary" })).resolves.toMatchObject({ embeddings: [[0.5]] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("passes the gate's own explanation through once its retries are spent", async () => {
    const fetch = vi.fn(shut);
    vi.stubGlobal("fetch", fetch);
    await expect(getOllamaClient().embed({ model: "m", input: "summary" })).rejects.toThrow("gate-shut-plover");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries a dropped connection", async () => {
    const responses = [() => Promise.reject(new TypeError("fetch failed")), ok];
    const fetch = vi.fn(() => responses.shift()!());
    vi.stubGlobal("fetch", fetch);
    await expect(getOllamaClient().embed({ model: "m", input: "summary" })).resolves.toMatchObject({ embeddings: [[0.5]] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
