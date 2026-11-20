export const CURRENT_SNAPSHOT = 'EXISTS (SELECT 1 FROM ingest_heads ih WHERE ih.current_session_id = s.id)'
