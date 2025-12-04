-- Migration: Add summary column to sessions for FTS on LLM-generated summaries
-- Summaries are more searchable than raw conversation content (less noise, semantic distillation)

-- Add summary column
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS summary TEXT;

-- Create FTS index on summaries
CREATE INDEX IF NOT EXISTS idx_sessions_summary_fts
ON sessions USING GIN (to_tsvector('english', summary))
WHERE summary IS NOT NULL;

-- Create trigram index for fuzzy matching on summaries
CREATE INDEX IF NOT EXISTS idx_sessions_summary_trgm
ON sessions USING GIN (summary gin_trgm_ops)
WHERE summary IS NOT NULL;

COMMENT ON COLUMN sessions.summary IS 'LLM-generated summary of the conversation for semantic search';

-- Search function that searches summaries (session-level) instead of raw messages
CREATE OR REPLACE FUNCTION search_session_summaries(
    search_query TEXT,
    limit_count INTEGER DEFAULT 50,
    source_filter VARCHAR DEFAULT NULL
)
RETURNS TABLE (
    session_id INTEGER,
    external_id VARCHAR,
    title VARCHAR,
    summary TEXT,
    project_name VARCHAR,
    project_path TEXT,
    source_name VARCHAR,
    started_at TIMESTAMPTZ,
    message_count INTEGER,
    rank REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.id as session_id,
        s.external_id,
        s.title,
        s.summary,
        p.name as project_name,
        p.path as project_path,
        src.name as source_name,
        s.started_at,
        s.message_count,
        ts_rank(to_tsvector('english', s.summary), plainto_tsquery('english', search_query)) as rank
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    JOIN sources src ON p.source_id = src.id
    WHERE
        s.summary IS NOT NULL
        AND to_tsvector('english', s.summary) @@ plainto_tsquery('english', search_query)
        AND (source_filter IS NULL OR src.name = source_filter)
    ORDER BY rank DESC, s.started_at DESC
    LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;
