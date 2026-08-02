-- Undo tables for the scaffolding backfill (issue #37), plus the journal that
-- makes it safely interruptible.
--
-- These were previously created ad hoc by `scripts/strip-scaffolding.ts` on
-- first run. A table that holds verbatim conversation text is schema, not a
-- script detail: it needs to exist before anyone reasons about a restore, it
-- needs to survive a fresh checkout, and its lifetime needs to be written down
-- somewhere other than in the head of whoever ran the backfill.
--
-- RETENTION. `message_content_backup` and `session_chunk_backup` hold full
-- pre-backfill conversation text and LLM-generated summaries indefinitely, on
-- purpose — they are the only copy of what the backfill overwrote, and a
-- retention window that expires before the operator notices a problem is not a
-- backup. They are NOT automatically cleaned. Once the result has been checked
-- and the backfill is not going to be reverted, drop the contents with:
--
--     pnpm tsx scripts/strip-scaffolding.ts --purge-backups --apply
--
-- Until that is run, treat these tables as being as sensitive as `messages`.

CREATE TABLE IF NOT EXISTS message_content_backup (
  message_id   BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  content_text TEXT NOT NULL,
  reason       TEXT NOT NULL,
  backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Session chunks are LLM output: regenerating one costs summarization time, and
-- the forward pass deletes every chunk of every affected session. Deleting
-- something expensive with no copy is the part of the operation that was not
-- actually reversible.
CREATE TABLE IF NOT EXISTS session_chunk_backup (
  id               BIGINT PRIMARY KEY,
  session_id       BIGINT NOT NULL,
  chunk_index      INT NOT NULL,
  start_message_id BIGINT NOT NULL,
  end_message_id   BIGINT NOT NULL,
  summary          TEXT NOT NULL,
  content_chars    BIGINT NOT NULL,
  created_at       TIMESTAMPTZ,
  backed_up_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_chunk_backup_session
  ON session_chunk_backup(session_id);

-- Postgres and Chroma cannot be written atomically. Whichever order the two
-- deletes happen in, a crash in the window between them leaves one side
-- inconsistent — and the survivable direction is a Chroma vector whose row is
-- gone, because vector search reads Chroma directly (src/mcp/search.ts) and
-- keeps returning it while nothing in Postgres can still name it.
--
-- So the intent is written down first. A row here means "this vector is meant
-- to be gone"; any run drains the journal before it starts, so an interrupted
-- pass is finished by the next one rather than being lost. Deleting an id twice
-- is harmless; failing to delete it once is the bug this whole PR is about.
CREATE TABLE IF NOT EXISTS chroma_pending_deletes (
  chroma_collection TEXT NOT NULL,
  chroma_id         TEXT NOT NULL,
  queued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chroma_collection, chroma_id)
);
