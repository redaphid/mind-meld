CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_permalink
ON messages ((split_part(content_json->>'permalink', '?', 1)));
