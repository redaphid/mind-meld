# Mindmeld - Unified Conversation Index

Search your AI conversations across Claude Code and Cursor with semantic search, full-text search, and intelligent weighted centroid boosting.

## Features

- 🔍 **Hybrid Search** - Semantic (vector) + full-text search
- 🎯 **Weighted Search** - Boost results similar to specific sessions/projects
- 📊 **PostgreSQL + Chroma** - Relational data + vector embeddings
- 🔄 **Auto-sync** - Hourly conversation sync + 7-hour centroid updates
- 🌐 **MCP Server** - Integrates with Claude Code via Model Context Protocol
- 📈 **Analytics** - Tool usage stats, session summaries, project activity

## Prerequisites

### Required

1. **Docker** - For PostgreSQL and Chroma databases
   ```bash
   # macOS
   brew install --cask docker

   # Linux
   curl -fsSL https://get.docker.com | sh
   ```

2. **Node.js 20+** - Runtime for sync and MCP server
   ```bash
   # macOS (via Homebrew)
   brew install node

   # Or use nvm
   nvm install 20
   ```

3. **pnpm** - Package manager (version 10.x)
   ```bash
   npm install -g pnpm@latest
   ```

4. **Ollama** - For embeddings (BGE-M3 model)
   ```bash
   # macOS
   brew install ollama

   # Linux
   curl -fsSL https://ollama.com/install.sh | sh

   # Start Ollama service
   ollama serve

   # Pull embedding model (in another terminal)
   ollama pull bge-m3
   ```

### Optional

- **GitHub npm token** - For installing `@redaphid/cursor-conversations`
  - Create at: https://github.com/settings/tokens/new
  - Scopes needed: `read:packages`
  - Add to `~/.npmrc`: `//npm.pkg.github.com/:_authToken=YOUR_TOKEN`

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/redaphid/mind-meld.git
cd mind-meld
```

### 2. Configure GitHub npm registry

Create or edit `~/.npmrc`:

```
@redaphid:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

### 3. Install dependencies

```bash
pnpm install
```

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and update paths if needed:

```bash
# Data storage (defaults to ./data - creates postgres & chroma volumes)
DATA_DIR=./data

# PostgreSQL (default port 5433 to avoid conflicts)
POSTGRES_PASSWORD=mindmeld_dev

# Ollama (must be running with bge-m3 model)
OLLAMA_URL=http://localhost:11434

# Source paths - adjust for your system
CLAUDE_CODE_PATH=~/.claude

# macOS:
CURSOR_GLOBALSTATE_PATH=~/Library/Application Support/Cursor/User/globalStorage

# Linux:
# CURSOR_GLOBALSTATE_PATH=~/.config/Cursor/User/globalStorage

# Windows:
# CURSOR_GLOBALSTATE_PATH=%APPDATA%/Cursor/User/globalStorage
```

### 5. Start services

```bash
docker compose up -d
```

This starts:
- PostgreSQL (port 5433)
- Chroma (port 8001)
- Auto-sync container (hourly)
- Centroid computation (every 7 hours)

### 6. Initial sync

```bash
# Sync conversations from both sources
pnpm run sync

# Generate embeddings for semantic search
pnpm run sync:embeddings

# Compute centroids for weighted search
pnpm run compute:centroids
```

**⏱️ Time estimate:**
- First sync: 2-10 minutes (depends on conversation count)
- Embeddings: 10-60 minutes (depends on message count)
- Centroids: 5-15 minutes

## Usage

### MCP Server (Claude Code Integration)

Add to your `~/.claude/config.json`:

```json
{
  "mcpServers": {
    "mindmeld": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/mind-meld", "run", "mcp"],
      "env": {}
    }
  }
}
```

Restart Claude Code. You'll now have `search` and `getSession` tools available.

### Search via MCP

**Basic search:**
```typescript
search({
  query: "storefronts implementation",
  limit: 10
})
```

**CWD-aware search** (prioritizes local project):
```typescript
search({
  query: "authentication bug",
  cwd: "/Users/you/Projects/myapp"
})
```

**Weighted search** (like session #104057, unlike briefings):
```typescript
search({
  query: "technical implementation",
  likeSession: ["104057:1.5"],  // Boost 1.5x
  unlikeSession: ["briefing"],   // Suppress
  negativeQuery: "casual discussion"  // Semantic exclusion
})
```

### Command Line

```bash
# Search conversations
pnpm run search "your query"

# View statistics
pnpm run stats

# Manual sync
pnpm run sync              # Both sources
pnpm run sync:claude       # Claude Code only
pnpm run sync:cursor       # Cursor only
pnpm run sync:embeddings   # Generate embeddings
pnpm run compute:centroids # Recompute centroids
```

### Docker Management

```bash
# View logs
docker logs mindmeld-sync -f
docker logs mindmeld-centroids -f

# Restart services
docker compose restart

# Stop all services
docker compose down

# Reset database (⚠️ deletes all data)
pnpm run db:reset
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
└─ Centroid computation every 7 hours
```

## Weighted Centroid Search

Advanced semantic search using session and project centroids (average embeddings).

### Setup

```bash
# 1. Generate embeddings
pnpm run sync:embeddings

# 2. Compute centroids
pnpm run compute:centroids
```

### Parameters

- `likeSession` - Boost results similar to session(s)
- `unlikeSession` - Suppress results similar to session(s)
- `likeProject` - Boost results matching project(s)
- `unlikeProject` - Suppress results matching project(s)

### Weight Syntax

- Simple: `["123"]` - Default weight 1.0
- Weighted: `["123:1.5"]` - 1.5x boost
- Multiple: `["123:1.5", "456:0.5"]` - Combine

### Weight Scale

- `0.3-0.5` - Gentle nudge, diverse results
- `1.0` - Standard influence (default)
- `1.2-1.5` - Noticeable bias, strong preference
- `2.0+` - Aggressive, may over-filter

### Algorithm

Uses Rocchio with 0.2 dampening for negative weights:

```
Q' = Q - γN + Σ(w * C+) - Σ(γw * C-)
where γ = 0.2 (prevents over-suppression)
```

## Troubleshooting

### Embeddings not generating

**Check Ollama:**
```bash
# Verify Ollama is running
curl http://localhost:11434/api/tags

# Should return list including bge-m3
```

**Pull model if needed:**
```bash
ollama pull bge-m3
```

### PostgreSQL connection errors

**Check port isn't in use:**
```bash
lsof -i :5433
```

**Change port in `.env`:**
```bash
POSTGRES_PORT=5434  # Or any available port
```

### Chroma connection errors

**Check port isn't in use:**
```bash
lsof -i :8001
```

**Change port in `.env`:**
```bash
CHROMA_PORT=8002  # Or any available port
```

### Sync container not starting

**Check paths exist:**
```bash
ls -la ~/.claude/projects/
ls -la ~/Library/Application\ Support/Cursor/User/globalStorage/
```

**View logs:**
```bash
docker logs mindmeld-sync
```

### Out of disk space

**Check Docker volumes:**
```bash
docker system df
```

**Clean up old images:**
```bash
docker system prune -a
```

## Development

```bash
# Type check
pnpm run type-check

# Watch mode (MCP server)
pnpm run mcp:dev

# Build binary
pnpm run build:binary
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./data` | Docker volume storage |
| `POSTGRES_PORT` | `5433` | PostgreSQL port |
| `CHROMA_PORT` | `8001` | Chroma port |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `SYNC_INTERVAL_SECONDS` | `3600` | Sync frequency (1 hour) |
| `CENTROID_INTERVAL_SECONDS` | `25200` | Centroid update (7 hours) |
| `EMBEDDING_MODEL` | `bge-m3` | Ollama embedding model |
| `EMBEDDING_BATCH_SIZE` | `100` | Messages per batch |

### Ports (Non-Standard to Avoid Conflicts)

| Service | Port | Default |
|---------|------|---------|
| PostgreSQL | **5433** | 5432 |
| Chroma | **8001** | 8000 |
| Ollama | 11434 | 11434 (shared) |

## Contributing

See [CLAUDE.md](./CLAUDE.md) for development notes and architecture details.

## License

MIT

## Links

- [GitHub](https://github.com/redaphid/mind-meld)
- [cursor-conversations](https://github.com/redaphid/cursor-conversations)
