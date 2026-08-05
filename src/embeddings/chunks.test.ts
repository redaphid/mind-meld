import { describe, it, expect } from "vitest"
import {
  buildChunkTexts,
  formatForSummary,
  CHUNK_JOIN,
  type SessionMessage,
} from "./chunks.js"
import { chunkMessagesWithIndices, CHUNK_SIZE_CHARS } from "./summarize.js"

const msg = (id: number, role: string, content_text: string): SessionMessage => ({
  id,
  role,
  content_text,
})

describe("formatForSummary", () => {
  it("uppercases the role and brackets it", () => {
    expect(formatForSummary(msg(1, "user", "hello"))).toBe("[USER]: hello")
    expect(formatForSummary(msg(2, "assistant", "hi"))).toBe("[ASSISTANT]: hi")
  })

  it("keeps tool messages — the pipeline query does not filter them", () => {
    expect(formatForSummary(msg(3, "tool", "ran ls"))).toBe("[TOOL]: ran ls")
  })
})

describe("buildChunkTexts", () => {
  it("joins messages with the separator the summarizer actually sees", () => {
    const [chunk] = buildChunkTexts([msg(1, "user", "a"), msg(2, "assistant", "b")])
    expect(chunk).toBe(`[USER]: a${CHUNK_JOIN}[ASSISTANT]: b`)
  })

  it("never splits mid-message — every chunk is whole formatted messages", () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg(i, i % 2 ? "user" : "assistant", "x".repeat(2000)),
    )
    for (const text of buildChunkTexts(messages)) {
      for (const part of text.split(CHUNK_JOIN)) {
        expect(part).toMatch(/^\[(USER|ASSISTANT)\]: x+$/)
      }
    }
  })

  it("agrees with the loop in persistSessionChunks, so the CLI measures the real input", () => {
    const messages = Array.from({ length: 30 }, (_, i) =>
      msg(i, i % 2 ? "user" : "assistant", "y".repeat(3000)),
    )
    // Mirror of persistSessionChunks: format, chunk, join.
    const viaPipeline = chunkMessagesWithIndices(
      messages.map(formatForSummary),
      CHUNK_SIZE_CHARS,
    ).map((c) => c.messages.join(CHUNK_JOIN))

    expect(buildChunkTexts(messages)).toEqual(viaPipeline)
  })

  it("is deterministic — same input, same chunks", () => {
    const messages = Array.from({ length: 25 }, (_, i) => msg(i, "user", "z".repeat(2500)))
    expect(buildChunkTexts(messages)).toEqual(buildChunkTexts(messages))
  })

  it("produces one chunk when the transcript fits", () => {
    expect(buildChunkTexts([msg(1, "user", "short")])).toHaveLength(1)
  })

  it("produces multiple chunks past CHUNK_SIZE_CHARS", () => {
    const big = Array.from({ length: 6 }, (_, i) =>
      msg(i, "user", "w".repeat(CHUNK_SIZE_CHARS / 2)),
    )
    expect(buildChunkTexts(big).length).toBeGreaterThan(1)
  })
})
