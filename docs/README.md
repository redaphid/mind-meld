# Claude Convos MCP

A unified conversation indexer that syncs Claude Code and Cursor conversations into PostgreSQL with vector embeddings in ChromaDB for semantic search.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Claude Code   │     │     Cursor      │
│   ~/.claude/    │     │   state.vscdb   │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     │
              ┌──────▼──────┐
              │  Sync Layer │
              │  (parsers)  │
              └──────┬──────┘
                     │
         ┌───────────┴───────────┐
         │                       │
   ┌─────▼─────┐          ┌──────▼──────┐
   │ PostgreSQL │          │   ChromaDB  │
   │ (metadata) │          │ (embeddings)│
   └───────────┘          └─────────────┘
         │                       │
         └───────────┬───────────┘
                     │
              ┌──────▼──────┐
              │  MCP Server │
              │  (search)   │
              └─────────────┘
```

## Components

### Data Sources

- **Claude Code**: Parses JSONL conversation files from `~/.claude/projects/`
- **Cursor**: Reads SQLite state database via `@redaphid/cursor-conversations`

### Storage

- **PostgreSQL**: Stores conversation metadata, sessions, messages, and embedding tracking
- **ChromaDB**: Stores vector embeddings for semantic search
- **Ollama**: Generates embeddings using `nomic-embed-text` (1024 dimensions)

### Sync Behavior

The sync process is idempotent and handles:

1. **Incremental sync**: Only processes files modified since last sync
2. **Chroma verification**: Checks ChromaDB directly to detect missing/outdated embeddings
3. **Content tracking**: Re-embeds messages when content length changes
4. **Session summarization**: Long conversations are summarized before embedding

## Setup

### Prerequisites

- Docker & Docker Compose
- Node.js 20+
- pnpm
- Ollama with `nomic-embed-text` model

### Quick Start

```bash
# Start infrastructure
docker compose up -d

# Install dependencies
pnpm install

# Run initial sync
pnpm run sync

# Generate embeddings
pnpm run sync:embeddings
```

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_HOST` | `localhost` | PostgreSQL host |
| `POSTGRES_PORT` | `5433` | PostgreSQL port |
| `CHROMA_URL` | `http://localhost:8001` | ChromaDB URL |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API URL |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Ollama embedding model |

## CLI Commands

```bash
# Full sync (conversations + embeddings)
pnpm run sync

# Sync only conversations (skip embeddings)
pnpm run sync -- --skip-embeddings

# Sync specific source
pnpm run sync -- --source claude_code
pnpm run sync -- --source cursor

# Generate embeddings only
pnpm run sync:embeddings

# Check status
pnpm run status

# Search conversations
pnpm run search "your query"
```

## Docker Volumes

Data is persisted to `~/THE_SINK/semantic-code-sync/`:

- `postgresdb/` - PostgreSQL data
- `chromadb/` - ChromaDB vector store

## Database Schema

### PostgreSQL Tables

- `sources` - Data source definitions (claude_code, cursor)
- `projects` - Project/workspace paths
- `sessions` - Conversation sessions
- `messages` - Individual messages with content
- `embeddings` - Tracks what's been embedded in Chroma
- `sync_state` - Last sync timestamps and stats

### ChromaDB Collections

- `convo-messages` - Message-level embeddings
- `convo-sessions` - Session-level embeddings (summarized)
