# Mindmeld Multi-Instance Setup: Huddle Isolation

Run a separate huddle-only mindmeld instance to keep sensitive transcripts isolated from the shared instance.

## Architecture

```
PUBLIC (Cloudflare tunnel) - EXISTING
├── Claude Code + Cursor data
├── mindmeld on port 3847
└── Tunneled for coworker access

PRIVATE - HUDDLES ONLY (new)
├── Slack huddle transcripts only
├── mindmeld-huddles on port 3849
└── NO tunnel - localhost only
```

## Quick Start

**Main instance (shareable):**
```bash
docker compose up -d
# Port 3847
```

**Huddles instance (private):**
```bash
docker compose -f docker-compose.huddles.yml up -d
# Port 3849
```

**Sync huddles:**
```bash
cd ~/mechs/slack-closed-captions
bun sync-to-mindmeld.mjs
# Posts to localhost:3849 by default
```

## Security

Huddle data cannot leak because:
1. Separate database volume (`mindmeld-huddles-postgres`)
2. Separate Chroma volume (`mindmeld-huddles-chroma`)
3. `sync-to-mindmeld.mjs` targets port 3849, not 3847
4. No tunnel configured for huddles instance

## Cleanup

To remove huddle data from main instance:

```sql
DELETE FROM messages WHERE session_id IN (
  SELECT s.id FROM sessions s
  JOIN projects p ON s.project_id = p.id
  JOIN sources src ON p.source_id = src.id
  WHERE src.name = 'huddle'
);
DELETE FROM sessions WHERE project_id IN (
  SELECT p.id FROM projects p
  JOIN sources src ON p.source_id = src.id
  WHERE src.name = 'huddle'
);
DELETE FROM projects WHERE source_id = (SELECT id FROM sources WHERE name = 'huddle');
DELETE FROM sources WHERE name = 'huddle';
```
