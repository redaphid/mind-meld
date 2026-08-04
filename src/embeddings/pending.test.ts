import { describe, it, expect } from "vitest";
import {
  embeddableMessages,
  embeddableSessions,
  pendingMessagesCount,
  pendingSessionsCount,
} from "./pending.js";

// This module exists to stop one specific, silent failure: the dashboard
// counting work the embedder will never do. On 2026-08-03 that gap read 32,339
// pending — 30,961 noise-marked, 1,376 in deleted sessions, 2 tool messages —
// against zero real work, with an ETA in October 2027. Each guard below is one
// of the filters whose absence produced that number.
describe("embeddableMessages", () => {
  const { sql } = embeddableMessages();

  it("skips tool messages", () => {
    expect(sql).toContain("m.role != 'tool'");
  });

  it("skips deleted and automated sessions", () => {
    expect(sql).toContain("s.deleted_at IS NULL");
    expect(sql).toContain("s.is_automated = false");
  });

  it("skips anything already marked unembeddable", () => {
    expect(sql).toContain("skip.chroma_collection = 'UNEMBEDDABLE'");
    expect(sql).toContain("skip.id IS NULL");
  });

  it("still counts an already-embedded message as done", () => {
    expect(sql).toContain("e.chroma_collection = 'convo-messages'");
    expect(sql).toContain("e.id IS NULL");
  });

  // A NaN failure inside its retry budget and past its cooldown is healable —
  // real pending work. Suppressing it would swap one wrong number for another.
  it("does not suppress NaN failures that are still eligible for healing", () => {
    expect(sql).toContain("skip.failure_reason = 'nan'");
    expect(sql).toContain("skip.retry_count <");
    expect(sql).toMatch(/NOT \(\s*skip\.failure_reason/);
  });

  // The selector reserves $1 for its LIMIT, so the fragment's own placeholders
  // have to move. If they stop moving, the selector silently filters on the
  // wrong value.
  it("renumbers its parameters so a caller can reserve earlier ones", () => {
    expect(embeddableMessages(1).sql).toContain("skip.retry_count < $1");
    expect(embeddableMessages(2).sql).toContain("skip.retry_count < $2");
    expect(embeddableMessages(2).sql).toContain("make_interval(days => $3)");
    expect(embeddableMessages(2).params).toHaveLength(2);
  });

  it("applies a character ceiling only when asked for one", () => {
    expect(embeddableMessages(1).sql).not.toContain("LENGTH(m.content_text) <=");
    expect(embeddableMessages(1, 8000).sql).toContain(
      "LENGTH(m.content_text) <= 8000",
    );
  });

  // The ceiling is interpolated rather than parameterised, so it must never be
  // able to carry anything but a number.
  it("coerces the character ceiling to a number", () => {
    const hostile = "8000; DROP TABLE messages" as unknown as number;
    expect(embeddableMessages(1, hostile).sql).toContain(
      "LENGTH(m.content_text) <= NaN",
    );
    expect(embeddableMessages(1, hostile).sql).not.toContain("DROP TABLE");
  });
});

describe("embeddableSessions", () => {
  const sql = embeddableSessions("$1");

  it("skips warmups, deleted and automated sessions", () => {
    expect(sql).toContain("s.deleted_at IS NULL");
    expect(sql).toContain("s.is_automated = false");
    expect(sql).toContain("title");
  });

  // Deferred work is not queued work. Re-summarizing a live conversation from
  // scratch as it grows is waste, so both sides wait — and counting the wait as
  // backlog is what kept this number from ever reaching zero.
  it("defers sessions that are still active", () => {
    expect(sql).toContain("s.ended_at IS NULL OR s.ended_at < NOW() - INTERVAL '30 minutes'");
  });

  it("re-embeds a session whose content grew past the watermark", () => {
    expect(sql).toContain("s.content_chars > COALESCE(e.content_chars_at_embed, 0)");
  });
});

// The counters must be the predicate, not a copy that resembles it.
describe("the counters and the selectors cannot drift", () => {
  it("counts messages with exactly the fragment the selector selects with", () => {
    expect(pendingMessagesCount().sql).toContain(embeddableMessages(1).sql);
    expect(pendingMessagesCount().params).toEqual(embeddableMessages(1).params);
  });

  it("counts sessions with exactly the fragment the selector selects with", () => {
    expect(pendingSessionsCount("convo-sessions").sql).toContain(
      embeddableSessions("$1"),
    );
    expect(pendingSessionsCount("convo-sessions").params).toEqual([
      "convo-sessions",
    ]);
  });
});
