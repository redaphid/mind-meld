# Mindmeld - Unified Conversation Index

Search AI conversations across Claude Code and Cursor with semantic + full-text search and weighted centroid boosting.

## Quick Start

```bash
# Prerequisites: Docker, Node 20+, pnpm, Ollama
git clone https://github.com/redaphid/mind-meld.git
cd mind-meld

# Configure GitHub npm (create token at github.com/settings/tokens/new with read:packages)
echo "@redaphid:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_TOKEN" >> ~/.npmrc

# Install and configure
pnpm install
cp .env.example .env  # Edit paths if needed

# Start services
docker compose up -d

# Initial sync
pnpm run sync
pnpm run sync:embeddings
pnpm run compute:centroids
```

## MCP Server Integration

Add to `~/.claude/config.json`:

```json
{
  "mcpServers": {
    "mindmeld": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/mind-meld", "run", "mcp"]
    }
  }
}
```

## Search Examples

```typescript
// Basic
search({ query: "storefronts implementation" })

// CWD-aware (prioritizes local project)
search({ query: "auth bug", cwd: "/Users/you/Projects/app" })

// Weighted (boost like session #104057, suppress briefings)
search({
  query: "technical implementation",
  likeSession: ["104057:1.5"],
  unlikeSession: ["briefing"],
  negativeQuery: "casual"
})
```

**Weight scale:** 0.3-0.5 (gentle), 1.0 (default), 1.2-1.5 (strong), 2.0+ (aggressive)

## Commands

```bash
pnpm run sync              # Sync conversations
pnpm run sync:embeddings   # Generate embeddings
pnpm run compute:centroids # Compute centroids
pnpm run search "query"    # Search CLI
pnpm run stats             # Statistics
pnpm run db:reset          # Reset database
```

## Architecture

PostgreSQL (5433) stores conversations, Chroma (8001) stores embeddings.
Docker containers auto-sync hourly and recompute centroids every 7 hours.

## Troubleshooting

**Embeddings not working:**
```bash
curl http://localhost:11434/api/tags  # Check Ollama running
ollama pull bge-m3                    # Pull model
```

**Port conflicts:** Edit `.env` and change `POSTGRES_PORT` or `CHROMA_PORT`

**Sync issues:** Check paths exist and view logs with `docker logs mindmeld-sync`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_PORT` | 5433 | PostgreSQL port |
| `CHROMA_PORT` | 8001 | Chroma port |
| `OLLAMA_URL` | http://localhost:11434 | Ollama endpoint |
| `SYNC_INTERVAL_SECONDS` | 3600 | Sync frequency |
| `CENTROID_INTERVAL_SECONDS` | 25200 | Centroid updates |

See [CLAUDE.md](./CLAUDE.md) for development details.
