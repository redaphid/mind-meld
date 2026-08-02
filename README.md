# Mindmeld

**Your AI conversations, searchable.** Mindmeld indexes every Claude Code and
Cursor conversation on your machines into one local index, and hands it back to
Claude through MCP — so "how did I solve this last time?" has an answer.

Nothing leaves your hardware. Postgres, Chroma, and Ollama all run locally; there
are no cloud calls and no API keys.

```
  ~/.claude/projects/*.jsonl ─┐
                              ├─▶ sync ─▶ Postgres (metadata + full-text)
  Cursor state.vscdb ─────────┘     │     Chroma  (vectors: messages, chunks,
                                    │              sessions, projects)
                                    └─▶ Ollama (summaries + embeddings)

                        Claude Code ──MCP──▶ mindmeld :3847
```

---

## Quick start

**Prerequisite:** [Ollama](https://ollama.com/download), running on the host.
Mindmeld pulls the models it needs (`bge-m3`, plus the summarizer) on first run.

```bash
git clone https://github.com/redaphid/mind-meld.git
cd mind-meld
docker compose up -d
```

Then register the MCP server with Claude Code, at user scope so it works in every
repo:

```bash
claude mcp add --scope user --transport http mindmeld http://localhost:3847/mcp
```

Ask Claude *"what was I working on yesterday?"* and you're done.

Two things to know before you trust the results:

- **Sync does not run in `docker compose`.** It runs as a host process — see
  [Running the sync](#running-the-sync) below. Without it, nothing is indexed.
- **Your Ollama must have flash attention OFF.** `bge-m3` returns all-null
  vectors when it's on, and sync then appears to succeed while producing zero
  embeddings. One probe settles it:

  ```bash
  curl -s localhost:11434/api/embed -d '{"model":"bge-m3","input":"probe"}' | head -c 80
  # expect a long, non-null "embeddings":[[...]] array
  ```

Verify:

```bash
docker compose ps                    # postgres, chroma, mcp, centroids, warmups
curl localhost:3847/health           # {"status":"ok","name":"mindmeld",...}
curl localhost:3847/status | jq      # sync state, totals, embedding backlog
```

---

## How it works

Mindmeld indexes conversations at **four granularities**, and search fuses all of
them:

| Tier | Chroma collection | What it holds |
| --- | --- | --- |
| Message | `convo-messages` | One vector per message |
| Chunk | `convo-chunks` | An LLM summary of a span of ~dozens of messages |
| Session | `convo-sessions` | An LLM summary of a whole conversation |
| Project | `convo-projects` | Centroid of a project's sessions |

A search runs the semantic arms (session, chunk, message) and a Postgres
full-text arm in parallel, then fuses their rankings with reciprocal rank fusion.
Each hit reports which tier matched and a cursor into the match, so a result is
never a dead end.

Retrieval is **progressively disclosed** — you never get a wall of transcript by
accident:

```
search           → one line per hit: session_id, title, score, snippet, cursor
  └─ getSession  → digest: session summary + paged chunk manifest, no raw text
       └─ getChunk    → one chunk's full summary + its message-id range
       └─ getMessages → raw messages, windowed and capped at ~24K chars
            └─ getMessage → one oversized message, in full, on request
```

Session and project **centroids** (average embeddings) let you steer a query
toward or away from a style of work — see [USAGE.md](docs/USAGE.md#weighted-centroid-search).

---

## Running the sync

Sync is a CLI, not a service. It scans each machine's own `~/.claude/projects`
and Cursor storage, so **every machine you work on needs its own sync** pointed
at the shared index.

```bash
pnpm install
pnpm run sync                 # incremental (default)
pnpm run sync -- --full       # ignore incremental state, re-scan everything
pnpm run sync -- -s cursor    # one source only
```

To run it hourly on Linux, install the `mindmeld-sync` systemd user timer:

```bash
systemctl --user enable --now mindmeld-sync.timer   # or: mindmeld start
systemctl --user disable --now mindmeld-sync.timer  # or: mindmeld stop
loginctl enable-linger "$USER"                      # survive logout
```

Unit files and the toolchain-path gotcha (fnm/nvm shims don't exist for systemd):
[LINUX.md](docs/LINUX.md#systemd-user-timer--mind-the-toolchain-path). On macOS
the equivalent is `scripts/sync-host.sh` under launchd — it runs on the host
because Docker Desktop's network proxy backpressures Ollama and turns 3-second
summaries into 30-second ones.

---

## MCP tools

Point any MCP client at `http://localhost:3847/mcp` (HTTP) or run
`pnpm run mcp` (stdio).

| Tool | Purpose |
| --- | --- |
| `search` | Ranked hits across all four tiers. Filters: `cwd`, `projectOnly`, `since`, `source`, `mode`, `negativeQuery`, `excludeTerms`, centroid weights |
| `getSession` | Session digest: summary + paged chunk manifest |
| `getMessages` | Raw messages, by window or by message-id range, char-budgeted |
| `getMessage` | One message in full, uncapped |
| `getChunk` | One chunk's full summary and message range |
| `stats` | Sessions and messages per source |
| `reportUselessSession` | Soft-delete a noise session so it stops polluting search |
| `health` | Summary coverage, summary quality, embedding freshness *(stdio only)* |
| `getSessionTranscript` | Resolve a session by external id or title *(stdio only)* |

Full parameter reference and worked examples: **[USAGE.md](docs/USAGE.md)**.

---

## HTTP API

The same port serves a small REST surface next to `/mcp`, specified in
**[docs/openapi.yaml](docs/openapi.yaml)** (OpenAPI 3.1). The running server
serves its own copy at `http://localhost:3847/openapi.yaml`.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness. Touches no dependency — a 200 means the process is up, not that the pipeline is |
| `GET /status` | Sync state, index totals, embedding backlog, Chroma counts |
| `GET /openapi.yaml` | This deployment's API spec |
| `POST /api/ingest` | Push a conversation from a source Mindmeld doesn't sync itself |
| `POST\|GET\|DELETE /mcp` | MCP Streamable HTTP transport |

> **There is no authentication.** A Host-header allowlist (`localhost`,
> `127.0.0.1`, `mcp`) is the only gate, and `/api/ingest` writes to the index.
> Reach it over loopback, an SSH tunnel, or an authenticated Cloudflare Tunnel —
> never expose the port directly.

---

## Configuration

Defaults work on macOS with a local Ollama. Copy `.env.example` to `.env` to
override; every value below is an environment variable read by both the CLI and
the containers.

| Variable | Default | Notes |
| --- | --- | --- |
| `POSTGRES_HOST` / `POSTGRES_PORT` | `localhost` / `5433` | Non-standard port to avoid clashing with a local Postgres |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `mindmeld` / `mindmeld` / `conversations` | Must match across every machine feeding one index |
| `CHROMA_HOST` / `CHROMA_PORT` | `localhost` / `8001` | |
| `MCP_HTTP_PORT` | `3847` | Host port published for the `mcp` container |
| `OLLAMA_URL` | `http://localhost:11434` | Serves both vectorization (`bge-m3`) and generation (`qwen3`). Flash attention must be off |
| `OLLAMA_MAX_CONCURRENCY` | `1` | Over an SSH tunnel, concurrent requests each balloon to ~30s. Raise only when Ollama is local |
| `OLLAMA_TIMEOUT_MS` / `OLLAMA_MAX_RETRIES` | `120000` / `3` | Per-request timeout and retry count |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | `bge-m3` / `1024` | Changing the model requires re-embedding everything |
| `SUMMARIZE_MODEL` | `qwen3:8b` | Compose overrides this per-deployment |
| `CLAUDE_CODE_PATH` | `~/.claude` | Same on macOS and Linux |
| `CURSOR_PATH` | `~/.cursor/chats` | Read by the CLI |
| `CURSOR_GLOBALSTATE_PATH` | — | Read by `docker-compose.local.yml` for the bind mount. Linux: `~/.config/Cursor/User/globalStorage` |
| `SYNC_INTERVAL_SECONDS` | `3600` | Used by the sync loop scripts |
| `CENTROID_INTERVAL_SECONDS` | `25200` | Centroid recompute, every 7 hours |
| `WARMUP_INTERVAL_SECONDS` | `21600` | Warmup-session filtering |

Ports are summarized in [CLAUDE.md](CLAUDE.md#ports-non-standard-to-avoid-conflicts).

---

## Development

```bash
pnpm install          # pnpm is enforced by a preinstall hook
pnpm run dev          # HTTP MCP server, watch mode
pnpm test             # vitest
pnpm run type-check   # tsc --noEmit

pnpm run stats                # index statistics
pnpm run search "query"       # full-text search from the CLI
pnpm run sync:embeddings      # drain the pending-embedding queue
pnpm run compute:centroids    # recompute session/project centroids
pnpm run db:reset             # destroys all indexed data

# repair vectors built from text ollama silently clipped, pre-1.7.0
pnpm exec tsx scripts/backfill-truncated.ts --dry-run
```

Migrations in `init-db/` are applied automatically when the `mcp` container
starts (`src/db/migrations.ts`) — **never** by the sync CLI. Keep the host on the
newest version so a remote machine can't write rows its schema lacks.

### Deploying

Releases are semver-driven: bump `version` in `package.json` and push to `main`.
CI tags, builds, and pushes the images to GHCR; the host then runs
`docker compose pull && docker compose up -d`. A plain merge does **not** deploy.
Details in [CLAUDE.md](CLAUDE.md#deployment).

---

## Docs

| Doc | What's in it |
| --- | --- |
| [USAGE.md](docs/USAGE.md) | MCP tool reference, search recipes, retrieval flow |
| [openapi.yaml](docs/openapi.yaml) | HTTP API specification |
| [DOCKER.md](docs/DOCKER.md) | Compose setup, services, configuration, troubleshooting |
| [MULTI-MACHINE.md](docs/MULTI-MACHINE.md) | One shared brain; connecting laptops over SSH |
| [LINUX.md](docs/LINUX.md) | Linux paths, the flash-off embedding Ollama, systemd, host networking |
| [huddle-isolation.md](docs/huddle-isolation.md) | Running a second, private instance for sensitive transcripts |

---

## Troubleshooting

**Search returns nothing, but sync says it succeeded.** Almost always dead
embeddings from flash attention. Probe Ollama — a non-null array is the only
proof:

```bash
curl -s localhost:11434/api/embed -d '{"model":"bge-m3","input":"probe"}' | head -c 80
```

Then check the backlog: `curl -s localhost:3847/status | jq .pendingEmbeddings`.

**404s on summarization.** `ollama pull qwen3:8b` (or whatever `SUMMARIZE_MODEL`
is set to).

**Connection refused to Ollama.** `ollama serve`, or start Ollama.app. From a
container on native Docker Engine, `host.docker.internal` doesn't resolve without
`extra_hosts: ["host.docker.internal:host-gateway"]` — see [LINUX.md](docs/LINUX.md#hosting-the-docker-stack-on-native-linux).

**The index looks smaller than your history.** Sync only reads what's *currently
on disk*; Claude Code rotates old transcripts away. Mindmeld is the durable
archive from the day you start syncing forward — and only for machines that are
actually syncing.

More in [DOCKER.md](docs/DOCKER.md#troubleshooting).
