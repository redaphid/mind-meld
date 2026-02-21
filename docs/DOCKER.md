# Mindmeld Docker Setup

Index your Claude Code and Cursor conversations for semantic search.

## Prerequisites

**Ollama** must be installed and running on your machine. The Docker containers connect to your host Ollama for embeddings and summarization.

```bash
# Install Ollama (https://ollama.com/download)

# Verify Ollama is running
curl http://localhost:11434/api/tags

# Models (bge-m3, granite3-dense:2b) are pulled automatically on first sync.
```

## Quick Start

```bash
docker compose up -d
```

That's it for macOS. Services start automatically:
- Postgres on port 5433
- Chroma on port 8001
- MCP server on port 3847
- Sync runs hourly, centroids compute every 7 hours

**Linux users:** Create `.env` with your Cursor path:
```bash
CURSOR_GLOBALSTATE_PATH=~/.config/Cursor/User/globalStorage
```

## Verify It's Working

```bash
# All services healthy?
docker compose ps

# MCP responding?
curl http://localhost:3847/health
# → {"status":"ok","name":"mindmeld","version":"..."}

# Sync progress
docker logs mindmeld-sync --tail 20
```

## Services

| Service | Port | Purpose |
|---------|------|---------|
| postgres | 5433 | Conversation metadata + FTS |
| chroma | 8001 | Vector embeddings |
| sync | - | Hourly conversation sync |
| centroids | - | 7-hourly centroid computation |
| warmup-filter | - | Periodic embedding warmup |
| mcp | 3847 | MCP search API |

## What Gets Indexed

| Source | macOS Path | Linux Path |
|--------|------------|------------|
| Claude Code | `~/.claude` | `~/.claude` |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage` | `~/.config/Cursor/User/globalStorage` |

## Configuration

Most users don't need a `.env` file. Defaults work on macOS.

### Optional Overrides

```bash
# Custom ports (avoid conflicts)
POSTGRES_PORT=5433
CHROMA_PORT=8001
MCP_HTTP_PORT=3847

# Custom Ollama (if running on different machine)
OLLAMA_URL=http://192.168.1.100:11434

# Embedding model
EMBEDDING_MODEL=bge-m3
SUMMARIZE_MODEL=granite3-dense:2b

# Sync frequency
SYNC_INTERVAL_SECONDS=3600       # 1 hour
CENTROID_INTERVAL_SECONDS=25200  # 7 hours
```

### Custom Embedding Models

To use a different Ollama model:

```bash
# Pull model
ollama pull nomic-embed-text

# Update .env
EMBEDDING_MODEL=nomic-embed-text

# Rebuild embeddings
pnpm run db:reset
pnpm run sync
pnpm run sync:embeddings
```

## Remote Database Setup

Run Postgres and Chroma on a server while syncing from your laptop.

**On remote machine:**
```bash
# Start only database services
docker compose up -d postgres chroma

# Note the machine's IP or hostname
```

**On local machine (where Claude Code/Cursor are installed):**
```bash
pnpm install
cp .env.example .env

# Edit .env to point to remote databases:
# POSTGRES_HOST=192.168.1.100  # Your remote machine IP
# CHROMA_HOST=192.168.1.100
# OLLAMA_URL=http://localhost:11434  # Keep Ollama local for speed

pnpm run sync
```

**Notes:**
- Postgres and Chroma must be accessible from your machine (check firewalls)
- Ollama should stay local for best embedding performance
- Data persists on whichever machine runs Postgres/Chroma

## Common Operations

```bash
# View logs
docker logs mindmeld-sync -f      # Sync progress
docker logs mindmeld-mcp -f       # MCP requests

# Force immediate sync
docker restart mindmeld-sync

# Reset everything (deletes all indexed data)
docker compose down -v
docker compose up -d

# Update images
docker compose pull
docker compose up -d
```

## Troubleshooting

### Sync shows 404 errors on summarization

Models should auto-pull, but you can manually pull if needed:
```bash
ollama pull granite3-dense:2b
```

### Sync shows connection refused to Ollama

Ollama isn't running:
```bash
ollama serve
```

Or on macOS, ensure Ollama.app is running in the menu bar.

### Permission denied reading conversations

Docker Desktop needs filesystem access on macOS:
Settings > Resources > File Sharing > Add paths

### Cursor conversations not syncing

Wrong path for your OS. Linux users need:
```bash
echo "CURSOR_GLOBALSTATE_PATH=~/.config/Cursor/User/globalStorage" >> .env
```

### Port already in use

Edit `.env` to use different ports:
```bash
POSTGRES_PORT=5434
CHROMA_PORT=8002
MCP_HTTP_PORT=3848
```

## Architecture

```
Your Machine
├── Ollama (host)            → Embeddings + Summarization (Metal/CUDA accelerated)
│   ├── bge-m3              → 1024-dim embeddings
│   └── granite3-dense:2b            → Conversation summaries
│
└── Docker
    ├── postgres (5433)      → Metadata + full-text search
    ├── chroma (8001)        → Vector embeddings
    ├── sync (background)    → Reads ~/.claude, writes to postgres/chroma
    ├── centroids (background) → Computes session/project centroids
    └── mcp (3847)           → HTTP API for Claude Code
```

## Remote Access

For accessing from other machines, use Cloudflare Tunnel:

```bash
# Set your tunnel token in .env
CLOUDFLARE_TUNNEL_TOKEN=your-token-here

# Start with tunnel profile
docker compose --profile tunnel up -d
```
