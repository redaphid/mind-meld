-- The embedder's selection (nextMessagesToEmbed in src/embeddings/pending.ts)
-- walks this newest-first and stops at its LIMIT. Without it, every eligible
-- message is sorted first: 5.4M rows, 1.2 GB on disk, past the 120s timeout.
-- Hand-made on one host before it was ever in a migration, hence IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_messages_embedding_eligible
ON messages ("timestamp" DESC, id DESC) INCLUDE (session_id)
WHERE content_text IS NOT NULL AND LENGTH(content_text) > 10 AND role != 'tool';
