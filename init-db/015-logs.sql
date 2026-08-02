-- Migration: Central log table
-- Every mindmeld process (mcp, sync on each machine) writes its console output
-- here so /logs can show all machines in one place. Containers cannot read each
-- other's stdout, and machines cannot read each other's at all, so the database
-- is the only shared surface. stdout is still written as before — this is an
-- addition, not a replacement, and `docker logs` keeps working.

CREATE TABLE IF NOT EXISTS logs (
    id BIGSERIAL PRIMARY KEY,
    machine VARCHAR(64) NOT NULL,
    service VARCHAR(64) NOT NULL,
    level VARCHAR(10) NOT NULL,
    message TEXT NOT NULL,
    logged_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The default read is "newest first, everything"; the others are the /logs
-- filters. logged_at is the process's own clock, so ties break on id.
CREATE INDEX IF NOT EXISTS idx_logs_logged_at ON logs(logged_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_logs_machine ON logs(machine, logged_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, logged_at DESC, id DESC);
