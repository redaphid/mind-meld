-- Migration: Add content_chars to sessions for incremental sync detection
-- This allows us to detect when a session has grown (new messages added)
-- and needs to be re-embedded in Chroma

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS content_chars BIGINT DEFAULT 0;

-- Create index for quick lookups when checking if re-embedding is needed
CREATE INDEX IF NOT EXISTS idx_sessions_content_chars ON sessions(content_chars);

-- Also add content_chars to embeddings table to track what was embedded
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS content_chars_at_embed BIGINT;

COMMENT ON COLUMN sessions.content_chars IS 'Total character count of all message content in this session';
COMMENT ON COLUMN embeddings.content_chars_at_embed IS 'Content chars of session when this embedding was created - if current > this, re-embed';
