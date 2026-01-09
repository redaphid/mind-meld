# Mindmeld Docker Setup

Index your Claude Code and Cursor conversations for semantic search.

## Prerequisites

**Ollama** must be installed and running on your machine. The Docker containers connect to your host Ollama for embeddings and summarization.

```bash
# Install Ollama
brew install ollama

# Pull required models
ollama pull bge-m3      # Embeddings (~1.2GB)
ollama pull qwen3:4b    # Summarization (~2.5GB)

# Verify Ollama is running
curl http://localhost:11434/api/tags
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
# → {"status":"ok","name":"mindmeld","version":"0.1.0"}

# Sync progress
docker logs mindmeld-sync --tail 20
```

## Using with Claude Code

Add to `~/.claude/mcp_settings.json`:

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
What was I working on yesterday?
```

## Why Host Ollama?

Docker Ollama runs on CPU only (no GPU passthrough on macOS). This makes summarization extremely slow - 5+ minutes per conversation, often timing out.

Host Ollama uses Metal acceleration on macOS (or CUDA on Linux), making it 10-50x faster. Models also persist across restarts and are shared with other Ollama usage.

## Services

| Service | Port | Purpose |
|---------|------|---------|
| postgres | 5433 | Conversation metadata + FTS |
| chroma | 8001 | Vector embeddings |
| sync | - | Hourly conversation sync |
| centroids | - | 7-hourly centroid computation |
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
SUMMARIZE_MODEL=qwen3:4b

# Sync frequency
SYNC_INTERVAL_SECONDS=3600       # 1 hour
CENTROID_INTERVAL_SECONDS=25200  # 7 hours
```

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

Ollama doesn't have the required model:
```bash
ollama pull qwen3:4b
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
│   └── qwen3:4b            → Conversation summaries
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
