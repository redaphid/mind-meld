-- Track which model was used for summarization before embedding
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS summarize_model VARCHAR(100);
