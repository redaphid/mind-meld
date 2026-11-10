\set ON_ERROR_STOP on
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_embedding_eligible
    ON messages (timestamp DESC, id DESC) INCLUDE (session_id)
    WHERE content_text IS NOT NULL AND LENGTH(content_text) > 10 AND role <> 'tool';
