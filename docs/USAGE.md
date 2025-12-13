# Mindmeld Usage Guide

## Overview

Mindmeld is a **local-first conversation index** that unifies all your AI interactions from Claude Code and Cursor into a single, searchable database. Everything runs on your development machine - no cloud services, no external API calls.

## Privacy & Local Architecture

**Your conversations stay on your machine.** Mindmeld never sends data to external services:

- PostgreSQL and ChromaDB run in Docker containers on localhost
- Ollama generates embeddings locally (no OpenAI API calls)
- Optional Cloudflare Tunnel for remote access (you control the endpoint)
- Source conversations remain in `~/.claude/` and `~/.cursor/` unchanged

## Quick Start

```bash
# 1. Start all services
docker compose up -d

# 2. Install dependencies
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your paths

# 4. Run initial sync
pnpm run sync

# 5. Generate embeddings (can take time on first run)
pnpm run embeddings

# 6. Compute search centroids
pnpm run compute:centroids
```

## Search Examples

### Basic Semantic Search

Find conversations about a topic, even when exact keywords don't match:

```typescript
// Search all conversations
{
  query: "authentication and security patterns",
  limit: 10
}

// Results understand context - finds OAuth, JWT, session handling discussions
```

### Project-Aware Search

Automatically boost results from your current project:

```typescript
{
  query: "database optimization strategies",
  cwd: "/Users/you/Projects/my-app",
  projectOnly: true  // Only search this project
}
```

### Time-Range Filtering

Find recent or historical conversations:

```typescript
{
  query: "API error handling",
  since: "7d"  // Last 7 days
}

{
  query: "legacy refactoring patterns",
  since: "2024-01-01",
  until: "2024-06-30"
}
```

### Weighted Centroid Search (Advanced)

Find conversations similar to specific sessions or projects:

```typescript
// "Find conversations like session 12345 but NOT like briefing sessions"
{
  query: "storefronts implementation",
  likeSession: ["12345:1.5"],  // 1.5x boost for this style
  unlikeSession: ["briefing-session:0.5"],  // Suppress this style
  cwd: "/Users/you/Projects/sibi/rza"
}

// Weight scale:
// 0.3-0.5: Gentle nudge
// 1.0: Standard (default)
// 1.2-1.5: Strong preference
// 2.0+: Aggressive filtering
```

### Negative Query (Disambiguation)

Exclude unwanted interpretations of ambiguous terms:

```typescript
{
  query: "workers",
  negativeQuery: "employees HR hiring"  // Find Cloudflare Workers, not people
}

{
  query: "python",
  negativeQuery: "snake reptile"  // Programming language, not animals
}
```

### Source Filtering

Search only Claude Code or only Cursor:

```typescript
{
  query: "refactoring patterns",
  source: "claude_code"
}

{
  query: "debugging sessions",
  source: "cursor"
}
```

## MCP Tools Reference

### `search`

Search conversations with semantic ranking:

**Parameters:**
- `query` (string): Natural language search query
- `limit` (number, optional): Max results (default: 20)
- `cwd` (string, optional): Current directory - boosts matching projects
- `projectOnly` (boolean, optional): Only search current project
- `since` / `until` (string, optional): Time range filters
- `source` (enum, optional): "claude_code" or "cursor"
- `likeSession` / `unlikeSession` (array, optional): Weighted session centroids
- `likeProject` / `unlikeProject` (array, optional): Weighted project centroids
- `negativeQuery` (string, optional): Semantic exclusion
- `mode` (enum, optional): "semantic" (default), "text", or "hybrid"

**Example Response:**
```json
{
  "results": [
    {
      "sessionId": 104057,
      "title": "Implementing OAuth2 Authentication Flow",
      "preview": "Started by setting up passport.js with OAuth2 strategy...",
      "score": 0.89,
      "source": "claude_code",
      "project": "auth-service",
      "startedAt": "2024-12-01T14:30:00Z",
      "messageCount": 47
    }
  ]
}
```

### `getSession`

Retrieve full conversation with all messages and tool calls:

**Parameters:**
- `sessionId` (number): Session ID from search results
- `messageLimit` (number, optional): Max messages to return (default: 50)

**Example Response:**
```json
{
  "session": {
    "id": 104057,
    "title": "Implementing OAuth2 Authentication Flow",
    "source": "claude_code",
    "project": "auth-service",
    "messageCount": 47,
    "messages": [
      {
        "id": 523001,
        "role": "user",
        "content": "Help me implement OAuth2 with Google",
        "timestamp": "2024-12-01T14:30:00Z"
      },
      {
        "id": 523002,
        "role": "assistant",
        "content": "I'll help you set up OAuth2...",
        "timestamp": "2024-12-01T14:30:15Z",
        "toolCalls": [
          {
            "tool": "Read",
            "input": {"file_path": "/app/config/auth.ts"}
          }
        ]
      }
    ]
  }
}
```

### `stats`

Get overview statistics:

**Example Response:**
```json
{
  "sources": [
    {"name": "claude_code", "sessionCount": 1234, "messageCount": 45678},
    {"name": "cursor", "sessionCount": 567, "messageCount": 33003}
  ],
  "totalSessions": 1801,
  "totalMessages": 78681,
  "embeddedMessages": 78681,
  "lastSync": "2024-12-12T10:15:00Z"
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    MINDMELD                              │
└─────────────────────────────────────────────────────────┘

SOURCES:
├─ ~/.claude/projects/     → Claude Code conversations
└─ ~/.cursor/chats/        → Cursor conversations

SYNC (Hourly):
├─ mindmeld-sync           → Incremental conversation sync
└─ mindmeld-centroids      → Recompute search centroids (7h)

STORAGE:
├─ PostgreSQL (5433)       → Structured data + FTS
│  ├─ projects/sessions/messages
│  └─ Full-text search indexes
│
└─ ChromaDB (8001)         → Vector embeddings
   ├─ convo-messages       → Message-level
   ├─ convo-sessions       → Session-level
   └─ convo-projects       → Project-level

EMBEDDING:
└─ Ollama (11434)          → Local embedding generation
                             (granite3-dense:2b by default)

ACCESS:
├─ MCP Server (stdio)      → Claude Code integration
└─ mindmeld-mcp (HTTP)     → Remote access via Cloudflare Tunnel
```

## Service Ports (Non-Standard)

| Service    | Port  | Reason                    |
|------------|-------|---------------------------|
| PostgreSQL | 5433  | Avoid conflicts with 5432 |
| ChromaDB   | 8001  | Avoid conflicts with 8000 |
| HTTP MCP   | 3000  | Configurable via env var  |
| Ollama     | 11434 | Standard (shared)         |

## Data Flow

1. **Sync Process** (every hour):
   - Scans `~/.claude/projects/` for new/modified JSONL files
   - Scans `~/.cursor/chats/` for new/modified SQLite blobs
   - Extracts messages, metadata, tool calls
   - Inserts into PostgreSQL with incremental progress tracking
   - Marks messages for embedding generation

2. **Embedding Generation**:
   - Queries pending messages from PostgreSQL
   - Generates embeddings via Ollama (local)
   - Upserts into ChromaDB collections
   - Updates PostgreSQL with embedding IDs
   - Batches of 100 messages at a time

3. **Centroid Computation** (every 7 hours):
   - Aggregates message embeddings per session
   - Computes average (centroid) for each session/project
   - Stores in separate ChromaDB collections
   - Enables weighted semantic search

## Commands Reference

```bash
# Sync
pnpm run sync              # Incremental sync (default)
pnpm run sync -- --full    # Force full re-sync
pnpm run sync -- -s cursor # Sync only Cursor

# Embeddings
pnpm run embeddings        # Generate pending embeddings
pnpm run compute:centroids # Compute session/project centroids

# Search
pnpm run search "query"    # CLI search
pnpm run stats             # Show statistics

# Database
pnpm run db:reset          # Reset and rebuild schema

# Development
pnpm run dev               # MCP server (stdio mode)
pnpm run type-check        # TypeScript validation
```

## Configuration (.env)

```bash
# Required
POSTGRES_PASSWORD=your-secure-password
POSTGRES_PORT=5433
CHROMA_PORT=8001
DATA_DIR=/path/to/data/storage

# Paths to conversation sources
CLAUDE_CODE_PATH=/Users/you/.claude
CURSOR_GLOBALSTATE_PATH=/Users/you/.config/Cursor/User/globalStorage

# Ollama
OLLAMA_URL=http://host.docker.internal:11434

# Optional
SUMMARIZE_MODEL=granite3-dense:2b
SYNC_INTERVAL_SECONDS=3600
CENTROID_INTERVAL_SECONDS=25200
MCP_HTTP_PORT=3000

# Cloudflare Tunnel (optional)
CLOUDFLARE_TUNNEL_TOKEN=your-tunnel-token
```

## Workflow Examples

### Example 1: Find Similar Past Work

```typescript
// You're working on authentication
// Find how you solved this before

{
  query: "implementing OAuth2 authentication with refresh tokens",
  cwd: "/Users/you/Projects/new-auth-service",
  limit: 5
}

// Get full conversation for the best match
{
  sessionId: 104057  // From search results
}
```

### Example 2: Cross-Editor Search

```typescript
// Find discussions in both Claude Code and Cursor
// about database migrations

{
  query: "database migration strategies postgres",
  limit: 20
}

// Filter to just Cursor sessions
{
  query: "database migration strategies postgres",
  source: "cursor",
  limit: 10
}
```

### Example 3: Recent Project Context

```typescript
// Catch up on what you discussed last week
// in a specific project

{
  query: "API endpoints error handling",
  cwd: "/Users/you/Projects/api-gateway",
  since: "7d",
  projectOnly: true
}
```

### Example 4: Exclude Noise

```typescript
// Find technical architecture discussions
// but not daily standup summaries

{
  query: "system architecture microservices",
  negativeQuery: "standup meeting daily update",
  since: "30d"
}
```

## Performance Notes

- **Initial sync**: Can take 10-30 minutes for thousands of conversations
- **Incremental sync**: Usually under 1 minute (only new/modified files)
- **Embedding generation**: ~100-200 messages/minute on M1 Mac with Ollama
- **Search**: Sub-second for semantic queries (ChromaDB vector search)
- **Centroid computation**: ~5-10 minutes for 100K+ messages

## Troubleshooting

### Sync not finding conversations

```bash
# Check environment variables
cat .env | grep -E "CLAUDE_CODE_PATH|CURSOR_GLOBALSTATE_PATH"

# Verify paths exist
ls -la ~/.claude/projects/
ls -la ~/.config/Cursor/User/globalStorage/
```

### Embeddings stuck

```bash
# Check Ollama is running
curl http://localhost:11434/api/tags

# Check pending count
pnpm run stats

# Restart embedding generation
pnpm run embeddings
```

### Search returns no results

```bash
# Verify embeddings exist
docker exec mindmeld-postgres psql -U mindmeld -d conversations \
  -c "SELECT COUNT(*) FROM embeddings;"

# Check ChromaDB collections
curl http://localhost:8001/api/v1/collections
```

### Container won't start

```bash
# Check logs
docker compose logs mindmeld-sync
docker compose logs postgres
docker compose logs chroma

# Restart services
docker compose restart
```

## Advanced: Custom Embedding Models

To use a different Ollama model:

```bash
# Pull model
ollama pull nomic-embed-text

# Update .env
EMBED_MODEL=nomic-embed-text

# Rebuild embeddings
pnpm run db:reset
pnpm run sync
pnpm run embeddings
```

## Security Considerations

- **Database password**: Set strong `POSTGRES_PASSWORD` in .env
- **Network isolation**: Services only exposed to localhost by default
- **Cloudflare Tunnel**: Only enable if you need remote access
- **File permissions**: Ensure conversation source paths are read-only mounted
- **.env file**: Never commit to version control (in .gitignore)

## What Gets Synced

### Claude Code
- Conversation sessions (*.jsonl in projects/)
- Subagent sessions (agent-*.jsonl)
- Messages with role, content, timestamps
- Tool calls (Read, Write, Bash, etc.)
- Project paths and metadata

### Cursor
- Chat sessions from workspace-specific stores
- Messages with role, content, timestamps
- Workspace associations
- Session titles and metadata

### What's NOT Synced
- File contents (only paths from tool calls)
- Screenshots or images (stored as references)
- Temporary draft messages
- Deleted conversations
