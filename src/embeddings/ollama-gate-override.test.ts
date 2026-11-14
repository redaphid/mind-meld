import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getInteractiveOllamaClient,
  getOllamaClient,
  GATE_OVERRIDE_HEADER,
} from "./ollama.js";
import { config } from "../config.js";

// The GPU gate holds a shut gate for 180 s after every proxy restart. A
// person's search must pass it; queued background work must not.
const sentHeaders: Headers[] = [];

function stubOllama() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      sentHeaders.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sentHeaders.length = 0;
});

describe("the GPU gate override", () => {
  it("is sent by the interactive client on a query embedding", async () => {
    stubOllama();
    await getInteractiveOllamaClient().embed({ model: "bge-m3", input: "q" });
    expect(sentHeaders).toHaveLength(1);
    expect(sentHeaders[0].get(GATE_OVERRIDE_HEADER)).toBe("interactive");
  });

  it("keeps the headers the Ollama client set itself", async () => {
    stubOllama();
    await getInteractiveOllamaClient().embed({ model: "bge-m3", input: "q" });
    expect(sentHeaders[0].get("content-type")).toBe("application/json");
  });

  it("is never sent by the background client", async () => {
    stubOllama();
    await getOllamaClient().embed({ model: "bge-m3", input: "q" });
    expect(sentHeaders).toHaveLength(1);
    expect(sentHeaders[0].has(GATE_OVERRIDE_HEADER)).toBe(false);
  });
});

// A gate that still refuses (an override it will not honour) answers 503.
// The two clients must keep their opposite policies around that answer.
describe("a 503 from the gate", () => {
  let calls = 0;

  function stubRefusingOnce() {
    calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: "gate shut" }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "0" },
          });
        }
        return new Response(JSON.stringify({ embeddings: [[0.1]] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is waited out and retried by the background client", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    stubRefusingOnce();
    const pending = getOllamaClient().embed({ model: "bge-m3", input: "q" });
    await vi.advanceTimersByTimeAsync(config.ollama.retryDelayMs);
    const res = await pending;
    expect(calls).toBe(2);
    expect(res.embeddings).toEqual([[0.1]]);
  });

  it("fails the interactive client at once, without a retry", async () => {
    stubRefusingOnce();
    await expect(
      getInteractiveOllamaClient().embed({ model: "bge-m3", input: "q" }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
