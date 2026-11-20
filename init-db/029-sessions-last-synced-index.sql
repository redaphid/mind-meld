-- /status lists sessions synced in the last ten minutes on every request.
-- Without this it scans every session: 17s on a 567k-session index.
CREATE INDEX IF NOT EXISTS idx_sessions_last_synced
ON sessions (last_synced_at DESC);
