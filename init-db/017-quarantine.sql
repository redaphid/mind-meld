-- Migration: keep every record sync could not process
--
-- A single bad record used to fail an entire session, and once it failed there
-- was no copy of it anywhere: the only original was the source file, which may
-- rotate or be deleted long before anyone reads the error. This table is that
-- copy.
--
-- payload_base64 is deliberately not text: base64 is ASCII, so nothing about a
-- record's content — a NUL byte, invalid UTF-8, a lone surrogate — can make the
-- INSERT that quarantines it fail in turn. The store of last resort must not
-- share the failure modes of the thing it is storing.

CREATE TABLE IF NOT EXISTS sync_quarantine (
    id BIGSERIAL PRIMARY KEY,
    source VARCHAR(50) NOT NULL,
    machine VARCHAR(64),

    -- Where it came from. record_key identifies the record within the file
    -- (line number for JSONL, message uuid for a failed insert) so that a
    -- re-run updates the same row instead of piling up duplicates.
    file_path TEXT NOT NULL,
    record_key TEXT NOT NULL,
    line_number INTEGER,

    -- Enough context to put the record back where it belongs.
    session_external_id VARCHAR(255),
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,

    -- 'parse'  — the raw source line, which could not be read
    -- 'insert' — the parsed record, which could not be written
    stage VARCHAR(10) NOT NULL,
    payload_base64 TEXT NOT NULL,

    error TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Set when a replay succeeds. Rows are kept, not deleted: what went wrong
    -- and what fixed it is the useful part.
    resolved_at TIMESTAMPTZ,

    UNIQUE (source, file_path, record_key)
);

CREATE INDEX IF NOT EXISTS idx_quarantine_pending
    ON sync_quarantine(last_attempt_at DESC)
    WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_quarantine_session
    ON sync_quarantine(session_id);
