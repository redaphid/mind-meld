# Mindmeld Docker Setup

Zero-config deployment for indexing Claude Code and Cursor conversations.

## Quick Start

```bash
# Clone and start
git clone https://github.com/redaphid/claude-convos-mcp.git
cd claude-convos-mcp
docker compose up -d
```

That's it. The stack will:
1. Start PostgreSQL, ChromaDB, and Ollama
2. Download required AI models (~3.7GB on first run)
3. Sync your conversations every hour
4. Expose an MCP server on port 3847

## What Gets Indexed

| Source | Default Path | Container Mount |
|--------|--------------|-----------------|
| Claude Code | `~/.claude` | `/root/.claude` |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage` | `/root/.config/Cursor/User/globalStorage` |

**Linux users:** Set `CURSOR_GLOBALSTATE_PATH=~/.cursor/User/globalStorage` in `.env`

## Services

| Service | Port | Purpose |
|---------|------|---------|
| postgres | 5433 | Conversation metadata + FTS |
| chroma | 8001 | Vector embeddings |
| ollama | 11434 | Embedding generation |
| mcp | 3847 | MCP search API |

## Verify It's Working

```bash
# Check all services are healthy
docker compose ps

# MCP health check
curl http://localhost:3847/health
# Returns: {"status":"ok","name":"mindmeld","version":"0.1.0"}

# View sync progress
docker logs mindmeld-sync --tail 50
```

## Configuration

Copy `.env.example` to `.env` to customize:

```bash
cp .env.example .env
```

### Key Settings

```bash
# Use host Ollama instead of Docker (faster, shares existing models)
OLLAMA_URL=http://host.docker.internal:11434

# Custom source paths
CLAUDE_CODE_PATH=/path/to/your/.claude
CURSOR_GLOBALSTATE_PATH=/path/to/cursor/globalStorage

# Sync frequency (seconds)
SYNC_INTERVAL_SECONDS=3600      # Conversations: every hour
CENTROID_INTERVAL_SECONDS=25200 # Centroids: every 7 hours

# Embedding model
EMBEDDING_MODEL=bge-m3
SUMMARIZE_MODEL=qwen3:4b
```

## Two Modes

### Zero-Config (Default)

Uses Docker Ollama. Models download automatically on first start (~3.7GB):
- `bge-m3` (1.2GB) - embeddings
- `qwen3:4b` (2.5GB) - summarization

```bash
# .env
OLLAMA_URL=http://ollama:11434
```

### Host Ollama (Recommended for Development)

Faster startup, shares models with your local Ollama:

```bash
# .env
OLLAMA_URL=http://host.docker.internal:11434

# Stop Docker Ollama
docker compose stop ollama

# Ensure host Ollama has required models
ollama pull bge-m3
ollama pull qwen3:4b
```

## Using with Claude Code

Add to your Claude Code MCP config (`~/.claude/mcp_settings.json`):

```json
{
  "mcpServers": {
    "mindmeld": {
      "type": "streamableHttp",
      "url": "http://localhost:3847/mcp"
    }
  }
}
```

Then search your conversation history:
```
/mcp mindmeld search "how did I implement authentication"
```

## Common Operations

```bash
# View logs
docker logs mindmeld-sync -f      # Sync progress
docker logs mindmeld-mcp -f       # MCP requests
docker logs mindmeld-ollama -f    # Model downloads

# Force immediate sync
docker restart mindmeld-sync

# Reset everything (deletes all data)
docker compose down -v
docker compose up -d

# Update images
docker compose pull
docker compose up -d
```

## Remote Database Setup

Run databases on a server, sync from your laptop:

**On server:**
```bash
docker compose up -d postgres chroma ollama
```

**On laptop (.env):**
```bash
POSTGRES_HOST=your-server-ip
CHROMA_HOST=your-server-ip
OLLAMA_URL=http://your-server-ip:11434
```

```bash
# Run sync locally (reads from laptop, writes to server)
pnpm install
pnpm run sync
```

## Troubleshooting

### Ollama shows "unhealthy"

Normal during model download. Check progress:
```bash
docker logs mindmeld-ollama -f
```

### Sync finds 0 messages

Check mount paths are correct:
```bash
docker exec mindmeld-sync ls -la /root/.claude/projects/
```

### Permission denied on macOS

Docker Desktop needs filesystem access. Go to:
Settings > Resources > File Sharing > Add paths

### Cursor conversations not syncing

Cursor uses a different path on Linux vs macOS:
```bash
# macOS (default)
CURSOR_GLOBALSTATE_PATH=~/Library/Application Support/Cursor/User/globalStorage

# Linux
CURSOR_GLOBALSTATE_PATH=~/.cursor/User/globalStorage
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    MINDMELD                              │
└─────────────────────────────────────────────────────────┘

SOURCES (mounted read-only):
├─ ~/.claude/projects/     → Claude Code conversations
└─ ~/.cursor/chats/        → Cursor conversations

DOCKER SERVICES:
├─ postgres (5433)         → Metadata + full-text search
├─ chroma (8001)           → Vector embeddings
├─ ollama (11434)          → Embedding generation
├─ sync (background)       → Hourly conversation sync
├─ centroids (background)  → Centroid computation
└─ mcp (3847)              → Search API

VOLUMES (persistent):
├─ mindmeld-postgres       → PostgreSQL data
├─ mindmeld-chroma         → ChromaDB vectors
└─ mindmeld-ollama         → Downloaded models
```
