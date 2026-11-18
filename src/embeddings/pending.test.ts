import { describe, it, expect } from "vitest";
import {
  embeddableSessions,
  nextMessagesToEmbed,
  pendingMessagesCount,
  pendingSessionsCount,
  vectorisedMessagesCount,
} from "./pending.js";

// This module exists to stop one specific, silent failure: the dashboard
// counting work the embedder will never do. On 2026-08-03 that gap read 32,339
// pending — 30,961 noise-marked, 1,376 in deleted sessions, 2 tool messages —
// against zero real work, with an ETA in October 2027. Each guard below is one
// of the filters whose absence produced that number.
describe("the pending-messages predicate", () => {
  const { sql } = pendingMessagesCount();

  it("skips tool messages", () => {
    expect(sql).toContain("m.role != 'tool'");
  });

  it("skips deleted and automated sessions", () => {
    expect(sql).toContain("s.deleted_at IS NULL");
    expect(sql).toContain("s.is_automated = false");
  });

  it("skips anything already marked unembeddable", () => {
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM embeddings skip\s*WHERE skip\.message_id = m\.id\s*AND skip\.chroma_collection = 'UNEMBEDDABLE'/);
  });

  it("still counts an already-embedded message as done", () => {
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM embeddings e\s*WHERE e\.message_id = m\.id AND e\.chroma_collection = 'convo-messages'/);
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
    expect(pendingMessagesCount().sql).toContain("skip.retry_count < $1");
    expect(nextMessagesToEmbed().sql).toContain("skip.retry_count < $2");
    expect(nextMessagesToEmbed().sql).toContain("make_interval(days => $3)");
    expect(nextMessagesToEmbed().params).toHaveLength(2);
  });

  it("applies a character ceiling only when asked for one", () => {
    expect(nextMessagesToEmbed().sql).not.toContain("LENGTH(m.content_text) <=");
    expect(nextMessagesToEmbed(8000).sql).toContain(
      "LENGTH(m.content_text) <= 8000",
    );
  });

  // The ceiling is interpolated rather than parameterised, so it must never be
  // able to carry anything but a number.
  it("coerces the character ceiling to a number", () => {
    const hostile = "8000; DROP TABLE messages" as unknown as number;
    expect(nextMessagesToEmbed(hostile).sql).toContain(
      "LENGTH(m.content_text) <= NaN",
    );
    expect(nextMessagesToEmbed(hostile).sql).not.toContain("DROP TABLE");
  });
});

// Newest message first, matching idx_messages_embedding_eligible exactly. A
// NULLS LAST the index lacks makes PostgreSQL sort every eligible row instead
// (see pending.db.test.ts).
describe("nextMessagesToEmbed", () => {
  it("selects by newest message time before insertion id", () => {
    expect(nextMessagesToEmbed().sql).toMatch(/ORDER BY m\.timestamp DESC, m\.id DESC\s+LIMIT \$1/);
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
    const predicate = (sql: string) => sql.slice(sql.indexOf("FROM messages m")).split("ORDER BY")[0].trim();
    const selector = predicate(nextMessagesToEmbed().sql).replace(/\$(\d+)/g, (_, n) => `$${Number(n) - 1}`);
    expect(predicate(pendingMessagesCount().sql)).toBe(selector);
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

// The coverage bar once divided every embeddings row (sessions, chunks, noise
// markers) by every message (tool output, fragments, deleted sessions) and read
// 51% against 67 messages of real work. Done and pending must split one
// population, so each side has to apply every filter the other does.
describe("vectorisedMessagesCount", () => {
  const { sql } = vectorisedMessagesCount();
  const eligibility = [
    "m.content_text IS NOT NULL",
    "LENGTH(m.content_text) > 10",
    "m.role != 'tool'",
    "s.deleted_at IS NULL",
    "s.is_automated = false",
  ];

  it("counts only messages the embedder would ever work", () => {
    for (const filter of eligibility) expect(sql).toContain(filter);
  });

  it("shares that population with the pending count", () => {
    for (const filter of eligibility) expect(pendingMessagesCount().sql).toContain(filter);
  });

  it("counts a message once it has a message vector", () => {
    expect(sql).toContain("e.chroma_collection = 'convo-messages'");
    expect(sql).toContain("e.id IS NOT NULL");
    expect(sql).not.toContain("e.id IS NULL");
  });
});
