-- A title the summarizer wrote for a session whose summary is its own
-- transcript (sessions of 8,000 chars or less are stored verbatim). Without it
-- such a session titles as its first raw transcript line. NULL everywhere else:
-- a session with a real summary titles from that summary's opening sentence.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS generated_title TEXT;
