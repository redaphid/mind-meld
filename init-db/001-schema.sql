-- ============================================================
-- MINDMELD - Unified Conversation Index
-- PostgreSQL Schema v1.0
-- Supports: Claude Code, Cursor (extensible)
-- ============================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Source systems (extensible)
CREATE TABLE sources (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    base_path TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Projects/Workspaces
CREATE TABLE projects (
    id SERIAL PRIMARY KEY,
    source_id INTEGER REFERENCES sources(id),
    external_id VARCHAR(255) NOT NULL,
    path TEXT,
    name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ,
    UNIQUE(source_id, external_id)
);

CREATE INDEX idx_projects_source ON projects(source_id);
CREATE INDEX idx_projects_path ON projects(path);
CREATE INDEX idx_projects_name_trgm ON projects USING GIN (name gin_trgm_ops);

-- Sessions/Conversations
CREATE TABLE sessions (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    external_id VARCHAR(255) NOT NULL,
    title VARCHAR(500),
    is_agent BOOLEAN DEFAULT FALSE,
    parent_session_id INTEGER REFERENCES sessions(id),
    agent_id VARCHAR(50),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    message_count INTEGER DEFAULT 0,
    total_input_tokens BIGINT DEFAULT 0,
    total_output_tokens BIGINT DEFAULT 0,
    claude_version VARCHAR(20),
    model_used VARCHAR(100),
    git_branch VARCHAR(255),
    cwd TEXT,
    status VARCHAR(20) DEFAULT 'active',
    raw_file_path TEXT,
    file_modified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ,
    UNIQUE(project_id, external_id)
);

CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_model ON sessions(model_used);
CREATE INDEX idx_sessions_title_trgm ON sessions USING GIN (title gin_trgm_ops);

-- Messages
CREATE TABLE messages (
    id BIGSERIAL PRIMARY KEY,
    session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    external_id VARCHAR(255),
    parent_message_id BIGINT REFERENCES messages(id),
    role VARCHAR(20) NOT NULL,
    content_text TEXT,
    content_json JSONB,
    tool_name VARCHAR(100),
    tool_input JSONB,
    tool_result TEXT,
    thinking_text TEXT,
    model VARCHAR(100),
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_creation_tokens INTEGER,
    cache_read_tokens INTEGER,
    timestamp TIMESTAMPTZ NOT NULL,
    sequence_num INTEGER,
    is_sidechain BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(session_id, external_id)
);

CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp DESC);
CREATE INDEX idx_messages_role ON messages(role);
CREATE INDEX idx_messages_tool ON messages(tool_name) WHERE tool_name IS NOT NULL;
CREATE INDEX idx_messages_content_fts ON messages USING GIN (to_tsvector('english', content_text));
CREATE INDEX idx_messages_content_trgm ON messages USING GIN (content_text gin_trgm_ops);

-- Tool usage tracking
CREATE TABLE tool_usage (
    id BIGSERIAL PRIMARY KEY,
    message_id BIGINT REFERENCES messages(id) ON DELETE CASCADE,
    session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    tool_name VARCHAR(100) NOT NULL,
    tool_input JSONB,
    duration_ms INTEGER,
    success BOOLEAN,
    error_message TEXT,
    timestamp TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_tool_usage_name ON tool_usage(tool_name);
CREATE INDEX idx_tool_usage_session ON tool_usage(session_id);
CREATE INDEX idx_tool_usage_timestamp ON tool_usage(timestamp DESC);

-- Todos from Claude Code
CREATE TABLE todos (
    id SERIAL PRIMARY KEY,
    session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    message_id BIGINT REFERENCES messages(id),
    content TEXT NOT NULL,
    status VARCHAR(20) NOT NULL,
    active_form TEXT,
    sequence_num INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_todos_session ON todos(session_id);
CREATE INDEX idx_todos_status ON todos(status);

-- Plans from Claude Code
CREATE TABLE plans (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL UNIQUE,
    title VARCHAR(500),
    content TEXT NOT NULL,
    file_modified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ
);

CREATE INDEX idx_plans_content_fts ON plans USING GIN (to_tsvector('english', content));

-- History entries from Claude Code
CREATE TABLE history_entries (
    id BIGSERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    display_text TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    pasted_contents JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_history_project ON history_entries(project_id);
CREATE INDEX idx_history_timestamp ON history_entries(timestamp DESC);
CREATE INDEX idx_history_text_fts ON history_entries USING GIN (to_tsvector('english', display_text));

-- Sync state tracking
CREATE TABLE sync_state (
    id SERIAL PRIMARY KEY,
    source_id INTEGER REFERENCES sources(id),
    entity_type VARCHAR(50) NOT NULL,
    last_sync_timestamp TIMESTAMPTZ,
    last_file_modified TIMESTAMPTZ,
    files_processed INTEGER DEFAULT 0,
    records_synced INTEGER DEFAULT 0,
    last_error TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(source_id, entity_type)
);

-- Embedding references (links to Chroma)
CREATE TABLE embeddings (
    id BIGSERIAL PRIMARY KEY,
    message_id BIGINT REFERENCES messages(id) ON DELETE CASCADE,
    chroma_collection VARCHAR(100) NOT NULL,
    chroma_id VARCHAR(255) NOT NULL,
    embedding_model VARCHAR(100),
    dimensions INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(message_id, chroma_collection)
);

CREATE INDEX idx_embeddings_message ON embeddings(message_id);
CREATE INDEX idx_embeddings_chroma ON embeddings(chroma_collection, chroma_id);

-- Initialize source systems
INSERT INTO sources (name, display_name, base_path) VALUES
    ('claude_code', 'Claude Code', '~/.claude'),
    ('cursor', 'Cursor', '~/.cursor/chats');

-- ============================================================
-- Views
-- ============================================================

-- Session summaries
CREATE VIEW v_session_summaries AS
SELECT
    s.id,
    s.external_id,
    s.title,
    p.name as project_name,
    p.path as project_path,
    src.name as source_name,
    src.display_name as source_display_name,
    s.started_at,
    s.ended_at,
    s.message_count,
    s.total_input_tokens,
    s.total_output_tokens,
    s.total_input_tokens + s.total_output_tokens as total_tokens,
    s.model_used,
    s.status,
    s.is_agent,
    s.git_branch,
    EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.started_at) - s.started_at)) as duration_seconds
FROM sessions s
JOIN projects p ON s.project_id = p.id
JOIN sources src ON p.source_id = src.id;

-- Tool usage statistics
CREATE VIEW v_tool_stats AS
SELECT
    tool_name,
    COUNT(*) as usage_count,
    COUNT(DISTINCT session_id) as session_count,
    AVG(duration_ms) as avg_duration_ms,
    SUM(CASE WHEN success THEN 1 ELSE 0 END)::float / COUNT(*) as success_rate,
    MAX(timestamp) as last_used_at
FROM tool_usage
GROUP BY tool_name
ORDER BY usage_count DESC;

-- Project activity
CREATE VIEW v_project_activity AS
SELECT
    p.id,
    p.name,
    p.path,
    src.name as source_name,
    COUNT(DISTINCT s.id) as session_count,
    SUM(s.message_count) as total_messages,
    SUM(s.total_input_tokens + s.total_output_tokens) as total_tokens,
    MAX(s.started_at) as last_activity,
    MIN(s.started_at) as first_activity
FROM projects p
JOIN sources src ON p.source_id = src.id
LEFT JOIN sessions s ON p.id = s.project_id
GROUP BY p.id, p.name, p.path, src.name;

-- ============================================================
-- Functions
-- ============================================================

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
    timestamp TIMESTAMPTZ,
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
        m.timestamp,
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
    timestamp TIMESTAMPTZ,
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
        m.timestamp,
        m.sequence_num
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    JOIN sources src ON p.source_id = src.id
    LEFT JOIN messages m ON s.id = m.session_id
    WHERE s.external_id = session_uuid
    ORDER BY m.sequence_num, m.timestamp;
END;
$$ LANGUAGE plpgsql;

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
