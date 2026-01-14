-- Migration: Add warmup detection
-- Adds is_warmup column for filtering out warmup/noise sessions

-- Add is_warmup column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'is_warmup'
  ) THEN
    ALTER TABLE sessions ADD COLUMN is_warmup BOOLEAN DEFAULT false;
    CREATE INDEX idx_sessions_is_warmup ON sessions(is_warmup) WHERE is_warmup = true;
  END IF;
END $$;

-- Add warmup_distance column for storing semantic distance from warmup centroid
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'warmup_distance'
  ) THEN
    ALTER TABLE sessions ADD COLUMN warmup_distance REAL;
    CREATE INDEX idx_sessions_warmup_distance ON sessions(warmup_distance) WHERE warmup_distance IS NOT NULL;
  END IF;
END $$;

-- Add deleted_at column for soft deletes if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE sessions ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;
    CREATE INDEX idx_sessions_deleted_at ON sessions(deleted_at) WHERE deleted_at IS NOT NULL;
  END IF;
END $$;

-- Create config table for storing warmup centroid and other settings
CREATE TABLE IF NOT EXISTS system_config (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Initial warmup patterns (title-based detection as fallback)
-- These will be supplemented by semantic similarity
INSERT INTO system_config (key, value)
VALUES ('warmup_title_patterns', '["Warmup", "I''ll start by exploring", "I''m ready to help", "I''m Claude Code", "_adjusts lab", "No preview available"]'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Threshold for semantic warmup detection (distance from warmup centroid)
INSERT INTO system_config (key, value)
VALUES ('warmup_distance_threshold', '0.25'::jsonb)
ON CONFLICT (key) DO NOTHING;
