-- Migration: Ensure all required functions exist
-- This is idempotent - safe to run multiple times
-- Run manually after container restart if functions are missing:
--   docker exec mindmeld-postgres psql -U mindmeld -d conversations -f /docker-entrypoint-initdb.d/003-ensure-functions.sql

-- Update session statistics
CREATE OR REPLACE FUNCTION update_session_stats(p_session_id INTEGER)
RETURNS VOID AS $$
BEGIN
    UPDATE sessions SET
        message_count = (SELECT COUNT(*) FROM messages WHERE session_id = p_session_id),
        total_input_tokens = COALESCE((SELECT SUM(input_tokens) FROM messages WHERE session_id = p_session_id), 0),
        total_output_tokens = COALESCE((SELECT SUM(output_tokens) FROM messages WHERE session_id = p_session_id), 0),
        started_at = (SELECT MIN(timestamp) FROM messages WHERE session_id = p_session_id),
        ended_at = (SELECT MAX(timestamp) FROM messages WHERE session_id = p_session_id)
    WHERE id = p_session_id;
END;
$$ LANGUAGE plpgsql;

-- Full-text search across messages
CREATE OR REPLACE FUNCTION search_messages(
    search_query TEXT,
    limit_count INTEGER DEFAULT 50,
    source_filter VARCHAR DEFAULT NULL
)
RETURNS TABLE (
    message_id BIGINT,
    session_id INTEGER,
    project_name VARCHAR,
    source_name VARCHAR,
    role VARCHAR,
    content_text TEXT,
    message_timestamp TIMESTAMPTZ,
    rank REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.id as message_id,
        m.session_id,
        p.name as project_name,
        src.name as source_name,
        m.role,
        m.content_text,
        m.timestamp as message_timestamp,
        ts_rank(to_tsvector('english', m.content_text), plainto_tsquery('english', search_query)) as rank
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    JOIN sources src ON p.source_id = src.id
    WHERE
        to_tsvector('english', m.content_text) @@ plainto_tsquery('english', search_query)
        AND (source_filter IS NULL OR src.name = source_filter)
    ORDER BY rank DESC, m.timestamp DESC
    LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Get session with messages
CREATE OR REPLACE FUNCTION get_session_with_messages(session_uuid VARCHAR)
RETURNS TABLE (
    session_id INTEGER,
    session_title VARCHAR,
    project_name VARCHAR,
    source_name VARCHAR,
    message_id BIGINT,
    role VARCHAR,
    content_text TEXT,
    tool_name VARCHAR,
    message_timestamp TIMESTAMPTZ,
    sequence_num INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.id as session_id,
        s.title as session_title,
        p.name as project_name,
        src.name as source_name,
        m.id as message_id,
        m.role,
        m.content_text,
        m.tool_name,
        m.timestamp as message_timestamp,
        m.sequence_num
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    JOIN sources src ON p.source_id = src.id
    LEFT JOIN messages m ON s.id = m.session_id
    WHERE s.external_id = session_uuid
    ORDER BY m.sequence_num, m.timestamp;
END;
$$ LANGUAGE plpgsql;
