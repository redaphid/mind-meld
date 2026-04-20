-- Sessions can be superseded when a later session corrects or replaces their conclusions.
-- Kept separate from deleted_at (noise/useless) because superseded content is still valid
-- historically — it just shouldn't show up in default search anymore.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS superseded_by_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS supersede_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_superseded_at
  ON sessions (superseded_at)
  WHERE superseded_at IS NOT NULL;
