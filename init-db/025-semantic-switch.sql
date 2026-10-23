-- The semantic switch: run without the AI pipeline until someone turns it back
-- on.
--
-- Off means no Ollama work at all -- no embedding, no summarization, no query
-- vectors -- while transcripts keep landing in Postgres for full-text search.
-- It lives on the stand-down row (022-sync-pause.sql) for the same reason: the
-- workers that run the queue and the `mcp` process that serves the UI button
-- share nothing but this database.
--
-- A boolean, unlike stand-down's deadline, because this one is deliberately a
-- switch: someone who turns semantic off for a week means a week. Nothing is
-- lost while it is off -- every row still enters the embedding queue
-- (src/embeddings/pending.ts) -- so switching it back on drains the backlog.

ALTER TABLE sync_control
  ADD COLUMN IF NOT EXISTS semantic_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS semantic_changed_at TIMESTAMPTZ,
  -- Free text, so the UI can say who switched it and why.
  ADD COLUMN IF NOT EXISTS semantic_reason TEXT;
