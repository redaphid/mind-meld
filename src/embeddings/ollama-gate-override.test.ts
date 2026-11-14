import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getInteractiveOllamaClient,
  getOllamaClient,
  GATE_OVERRIDE_HEADER,
} from "./ollama.js";

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
