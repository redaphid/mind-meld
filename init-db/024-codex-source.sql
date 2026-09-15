-- Codex rollout JSONL files are a coding source alongside Claude Code.
INSERT INTO sources (name, display_name, base_path, data_class)
VALUES ('codex', 'Codex', '~/.codex', 'coding')
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  base_path = EXCLUDED.base_path,
  data_class = 'coding';
