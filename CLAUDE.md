# Mindmeld - Unified Conversation Index

## Overview

Mindmeld syncs conversations from Claude Code and Cursor into a unified PostgreSQL + Chroma database for full-text and semantic search across all AI conversations.

## Ports (Non-Standard to Avoid Conflicts)

| Service    | Port     | Default        |
| ---------- | -------- | -------------- |
| PostgreSQL | **5433** | 5432           |
| Chroma     | **8001** | 8000           |
| Ollama     | 11434    | 11434 (shared) |

## Quick Start

```bash
# Start services
docker compose up -d

# Install dependencies
pnpm install

# Copy and configure environment
cp .env.example .env

# Run initial sync
pnpm run sync
```

## Commands

```bash
pnpm run sync              # Full sync (incremental by default)
pnpm run sync -- --full    # Force full re-sync
pnpm run sync -- -s cursor # Sync only Cursor

pnpm run embeddings        # Generate pending embeddings
pnpm run search "query"    # Search conversations
pnpm run stats             # Show sync statistics
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    MINDMELD                              │
└─────────────────────────────────────────────────────────┘

SOURCES:
├─ ~/.claude/projects/     → Claude Code conversations
└─ ~/.cursor/chats/        → Cursor conversations

STORAGE:
├─ PostgreSQL (5433)       → Normalized relational data
│  ├─ projects             → Project/workspace metadata
│  ├─ sessions             → Conversation sessions
│  ├─ messages             → Individual messages
│  ├─ tool_usage           → Tool call tracking
│  └─ embeddings           → Chroma reference links
│
└─ Chroma (8001)           → Vector embeddings
   ├─ convo-messages       → Message-level embeddings
   ├─ convo-sessions       → Session-level embeddings
   └─ convo-projects       → Project-level embeddings

SYNC:
├─ Docker-based hourly cron (mindmeld-sync container)
├─ Incremental by default (only new/modified files)
└─ Progress tracking for resumability
```

## Data Sources

### Claude Code (`~/.claude/`)

- `projects/{encoded-path}/*.jsonl` - Conversation sessions
- `projects/{encoded-path}/agent-*.jsonl` - Subagent sessions
- `history.jsonl` - Global command history
- `plans/*.md` - Plan mode files

### Cursor (`~/.cursor/chats/`)

- `{workspace-hash}/{uuid}/store.db` - SQLite blob storage

## Database Schema

Key tables:

- `sources` - Source systems (claude_code, cursor)
- `projects` - Project/workspace mapping
- `sessions` - Conversation sessions with metadata
- `messages` - All messages with FTS indexing
- `embeddings` - Links to Chroma vectors

## Search

```sql
-- Full-text search
SELECT * FROM search_messages('your query', 50, 'claude_code');

-- Recent sessions
SELECT * FROM v_session_summaries
ORDER BY started_at DESC
LIMIT 20;

-- Tool usage stats
SELECT * FROM v_tool_stats;
```

## Development

```bash
# Reset database
pnpm run db:reset

# Watch mode
pnpm run dev

# Type check
pnpm run type-check
```

MANDATORY PROTOCOL: when a session is started in this project, run `pnpm run dev` in a background thread, if you aren't already. This allows Claude code to connect to it
