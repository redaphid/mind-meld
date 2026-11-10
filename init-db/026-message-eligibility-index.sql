\set ON_ERROR_STOP on
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_embedding_eligible
    ON messages (timestamp DESC, id DESC) INCLUDE (session_id)
    WHERE content_text IS NOT NULL AND LENGTH(content_text) > 10 AND role <> 'tool';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('idx_messages_embedding_eligible') AND indisvalid) THEN
        RAISE EXCEPTION 'idx_messages_embedding_eligible is invalid; rebuild it concurrently before retrying this migration';
    END IF;
END $$;
