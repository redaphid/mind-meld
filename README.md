# Mindmeld

Search your AI conversations across Claude Code and Cursor with semantic + full-text search.

## Quick Start

```bash
# 1. Install Ollama
brew install ollama
ollama pull bge-m3 && ollama pull qwen3:4b

# 2. Start Mindmeld
git clone https://github.com/redaphid/mind-meld.git
cd mind-meld
docker compose up -d
```

That's it for macOS. Your conversations sync automatically every hour.

**Linux users:** Create `.env` with `CURSOR_GLOBALSTATE_PATH=~/.config/Cursor/User/globalStorage`

## Connect to Claude Code

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "mindmeld": {
      "type": "http",
      "url": "http://localhost:3847/mcp"
    }
  }
}
```

Then ask Claude: "What was I working on yesterday?"

## Verify

```bash
docker compose ps                    # All healthy?
curl http://localhost:3847/health    # MCP responding?
docker logs mindmeld-sync --tail 20  # Sync progress
```

## Docs

- **[Docker Setup](docs/DOCKER.md)** - Full setup, troubleshooting, configuration
- **[CLAUDE.md](CLAUDE.md)** - Development guide, architecture, API reference

## Services

| Service | Port | Purpose |
|---------|------|---------|
| postgres | 5433 | Conversation metadata + FTS |
| chroma | 8001 | Vector embeddings |
| mcp | 3847 | HTTP API for Claude Code |

## Why Host Ollama?

Mindmeld uses your local Ollama (not Docker) because Docker Ollama runs CPU-only on macOS, making summarization 10-50x slower. Host Ollama uses Metal acceleration.

## Troubleshooting

**404 errors on summarization:** `ollama pull qwen3:4b`

**Connection refused to Ollama:** `ollama serve` or start Ollama.app

**See [docs/DOCKER.md](docs/DOCKER.md) for more.**
