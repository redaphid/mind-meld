-- ============================================================
-- MINDMELD - Centroid Support for Weighted Search
-- Adds centroid vectors to sessions and projects for style-based boosting
-- ============================================================

-- Add centroid columns to sessions table
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS centroid_vector TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS centroid_message_count INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS centroid_computed_at TIMESTAMPTZ;

-- Add centroid columns to projects table
ALTER TABLE projects ADD COLUMN IF NOT EXISTS centroid_vector TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS centroid_message_count INTEGER;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS centroid_computed_at TIMESTAMPTZ;

-- Indexes for faster centroid lookups
CREATE INDEX IF NOT EXISTS idx_sessions_centroid ON sessions(centroid_computed_at) WHERE centroid_vector IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_centroid ON projects(centroid_computed_at) WHERE centroid_vector IS NOT NULL;

-- ============================================================
-- Centroid Computation Functions
-- ============================================================

-- Compute session centroid (average of all message embeddings)
CREATE OR REPLACE FUNCTION compute_session_centroid(p_session_id INTEGER)
RETURNS JSONB AS $$
DECLARE
    message_count INTEGER;
    centroid_data JSONB;
BEGIN
    -- Check if session has messages
    SELECT COUNT(*) INTO message_count
    FROM messages
    WHERE session_id = p_session_id
      AND content_text IS NOT NULL
      AND LENGTH(content_text) > 10;

    IF message_count = 0 THEN
        RETURN jsonb_build_object(
            'centroid', NULL,
            'count', 0,
            'error', 'No messages found'
        );
    END IF;

    -- This is a placeholder - actual centroid computation happens in TypeScript
    -- This function just validates and returns metadata
    RETURN jsonb_build_object(
        'count', message_count,
        'session_id', p_session_id
    );
END;
$$ LANGUAGE plpgsql;

-- Compute project centroid (average of all message embeddings across all sessions)
CREATE OR REPLACE FUNCTION compute_project_centroid(p_project_id INTEGER)
RETURNS JSONB AS $$
DECLARE
    message_count INTEGER;
BEGIN
    -- Check if project has messages
    SELECT COUNT(*) INTO message_count
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    WHERE s.project_id = p_project_id
      AND m.content_text IS NOT NULL
      AND LENGTH(m.content_text) > 10;

    IF message_count = 0 THEN
        RETURN jsonb_build_object(
            'centroid', NULL,
            'count', 0,
            'error', 'No messages found'
        );
    END IF;

    -- Placeholder - actual computation in TypeScript
    RETURN jsonb_build_object(
        'count', message_count,
        'project_id', p_project_id
    );
END;
$$ LANGUAGE plpgsql;
