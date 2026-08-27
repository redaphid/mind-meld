-- The stand-down switch: stop the ingestion pass that is running, and let the
-- next scheduled cycle start normally.
--
-- Ingestion is the heaviest thing this machine does -- the embedding and
-- summarization passes hold an Ollama slot for minutes at a time -- and there
-- was no way to stand it down for a game or a ComfyUI run short of stopping
-- containers. The queue does not run in the process serving the UI; it runs in
-- the sync workers. Postgres is the only thing they and the UI both hold, so
-- the switch lives here.
--
-- A short-lived deadline rather than a boolean, because this is deliberately
-- NOT a pause. A worker stands down only while `stand_down_until` is still in
-- the future, and the window is minutes -- long enough to stop the pass in
-- flight and to catch a cycle just about to start, far short of the next one.
-- So the worst case of a forgotten press, or of a worker that dies mid-pass, is
-- one skipped cycle, never a frozen index.

CREATE TABLE IF NOT EXISTS sync_control (
  -- Exactly one row, forever: `id` can only ever be true, so a second insert
  -- collides with the primary key instead of creating a rival switch.
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  stand_down_until TIMESTAMPTZ,
  stand_down_at TIMESTAMPTZ,
  -- Free text, so the UI can say who asked and why.
  stand_down_reason TEXT
);

INSERT INTO sync_control (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
