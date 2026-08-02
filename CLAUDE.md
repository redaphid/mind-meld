# Mindmeld - Unified Conversation Index

Mindmeld syncs conversations from Claude Code into a unified PostgreSQL + Chroma database for full-text and semantic search across all AI conversations.

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

pnpm run sync:embeddings        # Generate pending embeddings
pnpm run compute:centroids # Compute session/project centroids for weighted search
pnpm run search "query"    # Search conversations
pnpm run stats             # Show sync statistics

pnpm run verify            # Compare session files on disk against the DB; exits nonzero on drift
pnpm run verify --repair   # Also clear the sync stamp on drifted sessions and recompute stats
```

A sync run that records any error exits nonzero and prints a per-run summary
(sessions, messages, skipped, quarantined, every error in full), so container
monitoring sees failures instead of an eternal exit 0.

## Web UI

The browser app lives in `public/`. It runs as its own container: the `ui`
compose service (`Dockerfile.ui`, image `mindmeld-ui`, host port 3848) serves
`public/` at `/` and reverse-proxies the API surface (`/mcp`, `/api`,
`/status`, `/health`, `/logs`, `/openapi.yaml`) to the `mcp` service — the
Cloudflare tunnel's public hostname (e.g. mindmeld.example.com) points at
`http://ui:3000`, one ingress rule, every path works. The `mcp` service (port
3847) still serves the same files at `/` as a fallback, so it stays fully
usable standalone and the tunnel keeps working during migration either way.

No build step: Preact and htm are vendored under `public/vendor/` and loaded
through an import map, so what is committed is what runs — edit a file, reload
the page.

- Views: status, search (vector / full-text / hybrid), browse, session reader,
  logs, quarantine.
- It is a PWA: installable, and the service worker keeps the last state readable
  when the tunnel drops. Bump `VERSION` in `public/sw.js` when shell files change.
- Icons are generated, not hand-drawn: `pnpm run icons`.

Reaching either service through the Cloudflare tunnel requires that hostname in
`ALLOWED_HOSTS` (comma-separated, added to the localhost defaults; both `ui`
and `mcp` read the same variable). There is no authentication — see the
trust-model note in `docs/openapi.yaml`.

## When sync cannot process a record

Nothing is dropped. A record that fails to parse or insert goes to
`sync_quarantine` whole — raw bytes, base64 so nothing in them can break the
copy — and the rest of the session still indexes.

```bash
pnpm run quarantine            # what is waiting, and why
pnpm run quarantine -- --retry # replay it
```

Also at `/#/quarantine` in the UI, and `GET /api/quarantine` /
`POST /api/quarantine/retry`. `quarantined` on `/status` is the number to alert
on: non-zero means data is waiting, not lost.

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
  cwd: "/Users/you/Projects/acme/storefronts"
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

Deploys are **semver-driven** — CI only builds images when `package.json`'s `version` changes. A plain merge to `main` does **not** deploy.

1. Bump `version` in `package.json` and push to `main`.
2. `.github/workflows/release.yml` (gated on `paths: ["package.json"]`) runs tests + build, then creates a GitHub Release with a `v{version}` tag.
3. `.github/workflows/docker-publish.yml` (on the `v*` tag / after Release completes) builds and pushes all images to GHCR: `mindmeld-sync` (`Dockerfile.sync`), `mindmeld-mcp` (`Dockerfile.http`), plus postgres/centroids/warmups. Image suffix = the matrix `image:` value, so `Dockerfile.http → mindmeld-mcp` (matches what compose pulls).
4. On the host: `docker compose pull && docker compose up -d`. Migrations auto-apply on `mcp` startup (`src/db/migrations.ts`).

`/deploy` (`.claude/commands/deploy.md`) automates the push → tag → CI-watch → pull → restart, but it reads the existing version and does **not** bump it — edit `package.json` first.

## No Truncation Policy

Never truncate strings returned to API consumers. This includes `.slice()`, `substring()`, or SQL `LEFT()`/`SUBSTRING()` on data returned by MCP tools or HTTP endpoints. If content is too large, use summaries (LLM-generated) or pagination (offset/limit) instead. Truncation silently destroys information and makes results useless for downstream LLMs.

Acceptable truncation: debug logging (`console.log`), embedding model input limits (model constraint, not a choice).
