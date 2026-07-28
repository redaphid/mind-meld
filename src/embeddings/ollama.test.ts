import { describe, it, expect, beforeEach } from "vitest";
import {
  isRecoverableEmbedError,
  isOversizeEmbedError,
  isNaNEmbedError,
} from "./ollama.js";

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
