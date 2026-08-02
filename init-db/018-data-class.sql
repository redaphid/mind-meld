-- Migration: Add data_class classification dimension
-- Search defaults to coding data only; SMS threads, notes, and meeting
-- transcripts stay invisible to coding agents unless explicitly requested.
-- Class lives on sources (every current source is homogeneous) with a
-- nullable per-project override for future mixed sources.
-- Effective class = COALESCE(projects.data_class, sources.data_class).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sources' AND column_name = 'data_class'
  ) THEN
    -- Fail closed: any source we haven't classified is invisible to coding agents.
    ALTER TABLE sources ADD COLUMN data_class VARCHAR(32) NOT NULL DEFAULT 'personal';
    ALTER TABLE projects ADD COLUMN data_class VARCHAR(32);  -- NULL = inherit from source

    UPDATE sources SET data_class = 'coding'   WHERE name IN ('claude_code', 'cursor');
    UPDATE sources SET data_class = 'personal' WHERE name = 'android';
    UPDATE sources SET data_class = 'meetings' WHERE name = 'huddle';
  END IF;
END $$;
