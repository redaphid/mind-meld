CREATE TABLE IF NOT EXISTS ingest_heads (
    project_id INTEGER NOT NULL REFERENCES projects(id),
    external_id TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    content_hash TEXT NOT NULL DEFAULT '',
    current_session_id INTEGER REFERENCES sessions(id),
    PRIMARY KEY (project_id, external_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ingest_heads_current_session_idx
    ON ingest_heads (current_session_id) WHERE current_session_id IS NOT NULL;
