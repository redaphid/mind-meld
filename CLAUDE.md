# Mindmeld - Unified Conversation Index

## Overview

Mindmeld syncs conversations from Claude Code and Cursor into a unified PostgreSQL + Chroma database for full-text and semantic search across all AI conversations.

## Quick Start (Docker)

**See [docs/DOCKER.md](docs/DOCKER.md) for full setup instructions.**

```bash
# 1. Install Ollama with required models
brew install ollama
ollama pull bge-m3 && ollama pull qwen3:4b

# 2. Start services
docker compose up -d
```

That's it for macOS. Linux users: set `CURSOR_GLOBALSTATE_PATH` in `.env`.

## Ports (Non-Standard to Avoid Conflicts)

| Service    | Port     | Purpose                    |
| ---------- | -------- | -------------------------- |
| PostgreSQL | **5433** | Metadata + full-text search |
| Chroma     | **8001** | Vector embeddings          |
| MCP        | **3847** | HTTP API for Claude Code   |

## Local Development Setup

```bash
# Install dependencies
pnpm install

# Copy and configure environment
cp .env.example .env

# Run manual sync
pnpm run sync
```

### Remote Database Setup (Postgres/Chroma on Remote Machine)

**Use case:** Run Postgres and Chroma on a server while syncing from your laptop.

**On remote machine:**
```bash
# Start only database services
docker compose up -d postgres chroma

# Note the machine's IP or hostname
```

**On local machine (where Claude Code/Cursor are installed):**
```bash
# Install dependencies
pnpm install

# Copy environment config
cp .env.example .env

# Edit .env to point to remote databases:
# POSTGRES_HOST=192.168.1.100  # Your remote machine IP
# CHROMA_HOST=192.168.1.100
# OLLAMA_URL=http://localhost:11434  # Keep Ollama local for speed

# Run sync (uses remote databases)
pnpm run sync
```

**Important notes:**
- Postgres and Chroma must be accessible from your machine (check firewalls)
- Ollama should stay local for best embedding performance
- The sync container can run on either machine (it just needs network access to both databases)
- Data persists on whichever machine runs Postgres/Chroma

## Commands

```bash
pnpm run sync              # Full sync (incremental by default)
pnpm run sync -- --full    # Force full re-sync
pnpm run sync -- -s cursor # Sync only Cursor

pnpm run embeddings        # Generate pending embeddings
pnpm run compute:centroids # Compute session/project centroids for weighted search
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
├─ Progress tracking for resumability
└─ Centroid computation every 7 hours (mindmeld-centroids container)
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

### Weighted Centroid Search

Advanced semantic search using session and project centroids (average embeddings):

**Setup:**
```bash
# 1. Generate embeddings first
pnpm run embeddings

# 2. Compute centroids (session and project averages)
pnpm run compute:centroids
```

**MCP Search Parameters:**
- `likeSession`: Boost results similar to specific session(s) style
- `unlikeSession`: Suppress results similar to specific session(s)
- `likeProject`: Boost results matching specific project(s) topics
- `unlikeProject`: Suppress results matching specific project(s)

**Weight Syntax:**
- Simple: `["123"]` - Default weight 1.0
- Weighted: `["123:1.5"]` - 1.5x boost
- Multiple: `["123:1.5", "456:0.5"]` - Combine multiple

**Weight Scale:**
- `0.3-0.5`: Gentle nudge, diverse results
- `1.0`: Standard influence (default)
- `1.2-1.5`: Noticeable bias, strong preference
- `2.0+`: Aggressive, may over-filter

**Example:**
```typescript
// Find sessions similar to session 104057 but not like briefing sessions
{
  query: "storefronts implementation",
  likeSession: ["104057:1.5"],
  unlikeSession: ["briefing-session:0.5"],
  cwd: "/Users/you/Projects/sibi/rza"
}
```

**Algorithm:** Uses Rocchio with 0.2 dampening for negative weights:
```
Q' = Q - γN + Σ(w * C+) - Σ(γw * C-)
where γ = 0.2 (prevents over-suppression)
```

**Automated Updates:**
Centroids are automatically recomputed every 7 hours by the `mindmeld-centroids` Docker container. This keeps search results fresh as new conversations are added. Adjust via `CENTROID_INTERVAL_SECONDS` in `.env`.

### SQL Search

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

## Chroma v3 API Reference

### Client Initialization

```typescript
import { ChromaClient } from "chromadb";

const client = new ChromaClient({
  path: "http://localhost:8001"  // Note: we use port 8001
});

// Health check
await client.heartbeat();
```

### Collection Management

```typescript
// Create collection (uses default embedding function if not specified)
const collection = await client.createCollection({ name: "my-collection" });

// Create without embedding function (must provide embeddings manually)
const collection = await client.createCollection({
  name: "my_collection",
  embeddingFunction: null,
});

// Get existing collection
const collection = await client.getCollection({
  name: "my-collection",
  embeddingFunction: embedder  // required for older versions
});
```

### Adding/Upserting Data

```typescript
// Add records
await collection.add({
  ids: ["id1", "id2"],
  embeddings: [[1, 2, 3], [4, 5, 6]],
  metadatas: [{ key: "value" }, { key: "value" }],
  documents: ["document1", "document2"],
});

// Upsert (add or update)
await collection.upsert({
  ids: ["id1", "id2"],
  embeddings: [[1.1, 2.3, 3.2], [4.5, 6.9, 4.4]],
  metadatas: [{ chapter: "3" }, { chapter: "5" }],
  documents: ["doc1", "doc2"],
});
```

### Querying

```typescript
// Query with text (requires embedding function on collection)
const results = await collection.query({
  queryTexts: ["my query"],
  nResults: 10
});

// Query with embeddings (no embedding function needed)
const results = await collection.query({
  queryEmbeddings: [[0.1, 0.2, 0.3]],
  nResults: 10
});

// Control returned fields
await collection.query({
  queryTexts: ["my query"],
  include: ["documents", "metadatas", "embeddings"],
});

// Get by IDs
await collection.get({ ids: ["id1", "id2"] });
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

## Deployment

Use `/deploy` to commit, push, tag, build Docker images via CI, pull, and restart containers.

## No Truncation Policy

Never truncate strings returned to API consumers. This includes `.slice()`, `substring()`, or SQL `LEFT()`/`SUBSTRING()` on data returned by MCP tools or HTTP endpoints. If content is too large, use summaries (LLM-generated) or pagination (offset/limit) instead. Truncation silently destroys information and makes results useless for downstream LLMs.

Acceptable truncation: debug logging (`console.log`), embedding model input limits (model constraint, not a choice).

MANDATORY PROTOCOL: when a session is started in this project, run `pnpm run dev` in a background thread, if you aren't already. This allows Claude code to connect to it
