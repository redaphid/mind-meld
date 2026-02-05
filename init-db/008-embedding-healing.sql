-- Embedding healing: track failure reasons and enable time-gated retries for NaN failures

ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS failure_reason VARCHAR(50);
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS failure_detail TEXT;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_embeddings_healing
  ON embeddings(failure_reason, retry_count, updated_at)
  WHERE chroma_collection = 'UNEMBEDDABLE';

-- Reclassify legacy 'none' rows as 'nan' with retry_count 0
-- Actual noise will be re-classified on first retry by the JS noise filter
UPDATE embeddings
SET failure_reason = 'nan', retry_count = 0, updated_at = NOW()
WHERE chroma_collection = 'UNEMBEDDABLE' AND failure_reason IS NULL;
