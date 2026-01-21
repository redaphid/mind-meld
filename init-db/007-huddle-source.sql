-- ============================================================
-- Add Huddle source for Slack huddle transcripts
-- ============================================================

-- Add huddle source
INSERT INTO sources (name, display_name, base_path)
VALUES ('huddle', 'Slack Huddles', '~/mechs/slack-closed-captions/huddles')
ON CONFLICT (name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    base_path = EXCLUDED.base_path;

-- Add index for channel-based queries (huddles use channel name as project)
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
