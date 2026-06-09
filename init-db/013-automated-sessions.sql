-- Migration: Add automated-session classification
-- Adds is_automated column so search can exclude non-interactive sessions
-- (Slack monitoring, curiosity curation, MCP health checks, huddle transcripts)
-- by default, without callers hand-rolling negativeQuery/excludeTerms.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'is_automated'
  ) THEN
    ALTER TABLE sessions ADD COLUMN is_automated BOOLEAN NOT NULL DEFAULT false;
    CREATE INDEX idx_sessions_is_automated ON sessions(is_automated) WHERE is_automated = true;
  END IF;
END $$;
