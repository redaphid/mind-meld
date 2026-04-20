-- Middle-tier summaries. A 1.85M-char session collapses to a ~2.7k-char session
-- summary, which is useful for search ranking but useless for a consumer that
-- wants to actually read the interesting slice. We already generate per-chunk
-- summaries (~3k chars each, 20+ per long session) during the session-level
-- combine step — this table persists them along with the message-id range each
-- chunk covers, so a caller can pull "outline → drill into chunk N" without
-- loading a multi-megabyte transcript.
--
-- Chunk embeddings are stored in the existing embeddings table with
-- chroma_collection='convo-chunks' and session_chunk_id set. ON DELETE CASCADE
-- means regenerating a session's chunks cleanly drops their embeddings too.

CREATE TABLE IF NOT EXISTS session_chunks (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  start_message_id BIGINT NOT NULL,
  end_message_id BIGINT NOT NULL,
  summary TEXT NOT NULL,
  content_chars BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_session_chunks_session ON session_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_session_chunks_range
  ON session_chunks(session_id, start_message_id, end_message_id);

ALTER TABLE embeddings
  ADD COLUMN IF NOT EXISTS session_chunk_id BIGINT
    REFERENCES session_chunks(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS embeddings_session_chunk_idx
  ON embeddings(session_chunk_id, chroma_collection)
  WHERE session_chunk_id IS NOT NULL;
