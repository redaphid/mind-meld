# Mindmeld - Unified Conversation Index

Mindmeld syncs conversations from Claude Code and Cursor into a unified PostgreSQL + Chroma database for full-text and semantic search across all AI conversations.

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

## Commands

```bash
pnpm run sync              # Full sync (incremental by default)
pnpm run sync -- --full    # Force full re-sync
pnpm run sync -- -s cursor # Sync only Cursor

pnpm run sync:embeddings        # Generate pending embeddings
pnpm run compute:centroids # Compute session/project centroids for weighted search
pnpm run search "query"    # Search conversations
pnpm run stats             # Show sync statistics
```

## Search

### Weighted Centroid Search

Advanced semantic search using session and project centroids (average embeddings):

**Setup:**
```bash
# 1. Generate embeddings first
pnpm run sync:embeddings

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

Centroids are automatically recomputed every 7 hours by the `mindmeld-centroids` Docker container. Adjust via `CENTROID_INTERVAL_SECONDS` in `.env`.

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

Use `/deploy` to commit, push, tag, build Docker images via CI, pull, and restart containers. See [deploy command](.claude/commands/deploy.md) for the full procedure.

## No Truncation Policy

Never truncate strings returned to API consumers. This includes `.slice()`, `substring()`, or SQL `LEFT()`/`SUBSTRING()` on data returned by MCP tools or HTTP endpoints. If content is too large, use summaries (LLM-generated) or pagination (offset/limit) instead. Truncation silently destroys information and makes results useless for downstream LLMs.

Acceptable truncation: debug logging (`console.log`), embedding model input limits (model constraint, not a choice).

MANDATORY PROTOCOL: when a session is started in this project, run `pnpm run dev` in a background thread, if you aren't already. This allows Claude code to connect to it
