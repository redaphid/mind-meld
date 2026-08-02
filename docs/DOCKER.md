# Mindmeld Docker Setup

The Docker stack runs the **storage and serving** half of Mindmeld: Postgres,
Chroma, the MCP server, and two background jobs. The **sync** half runs on the
host — see [Where sync runs](#where-sync-runs).

---

## Prerequisites

**Ollama on the host**, not in Docker. Docker's Ollama is CPU-only on macOS,
which makes summarization 10–50× slower; the host build uses Metal or CUDA.

Mindmeld needs **two** Ollama endpoints:

| Env var | Default | Model | Why separate |
| --- | --- | --- | --- |
| `OLLAMA_URL` | `http://localhost:11434` | `SUMMARIZE_MODEL` | Generation; flash attention is fine and helps |
| `OLLAMA_EMBEDDING_URL` | `http://localhost:21434` | `bge-m3` | **`bge-m3` returns all-null vectors when flash attention is ON** |

`OLLAMA_EMBEDDING_URL` does **not** fall back to `OLLAMA_URL`. If nothing is
listening on `:21434`, sync completes "successfully" and produces zero
embeddings. Always probe before trusting it:

```bash
curl -s localhost:21434/api/embed -d '{"model":"bge-m3","input":"probe"}' | head -c 80
# expect a long, non-null "embeddings":[[...]] array
```

Setting up the second instance: [LINUX.md](LINUX.md#dedicated-embedding-instance-flash-attention-off).
Models are pulled automatically on first run; you can pre-pull with
`ollama pull bge-m3`.

---

## Quick start

```bash
docker compose up -d
```

Pulls the published GHCR images and starts:

| Container | Image | Port | Purpose |
| --- | --- | --- | --- |
| `mindmeld-postgres` | `mindmeld-postgres` | 5433 → 5432 | Metadata + full-text search |
| `mindmeld-chroma` | `chromadb/chroma` | 8001 → 8000 | Vector collections |
| `mindmeld-mcp` | `mindmeld-mcp` | 3847 → 3000 | MCP + REST API; **applies migrations on startup** |
| `mindmeld-centroids` | `mindmeld-centroids` | — | Recomputes session/project centroids every 7h |
| `mindmeld-warmups` | `mindmeld-warmups` | — | Flags warmup/automated sessions every 6h |
| `mindmeld-cloudflared` | `cloudflare/cloudflared` | — | Optional; `--profile tunnel` only |

**Linux:** set your Cursor path in `.env` before starting —
`CURSOR_GLOBALSTATE_PATH=~/.config/Cursor/User/globalStorage`.

### Verify

```bash
docker compose ps
curl -s localhost:3847/health | jq        # {"status":"ok","name":"mindmeld",...}
curl -s localhost:3847/status  | jq       # sync state, totals, embedding backlog
```

`/status` is the honest one: `/health` returns 200 as long as the process is
alive, without touching Postgres, Chroma, or Ollama.

---

## Where sync runs

`docker-compose.yml` has **no `sync` service**. It was removed because Docker
Desktop's network proxy (gvisor/vpnkit) backpressures Ollama's response stream,
turning ~3-second chunk summaries into ~30-second ones. The same work on the host
takes ~1.6s.

So sync runs as a host process, reaching Postgres and Chroma through their
published ports:

- **macOS** — `scripts/sync-host.sh` under launchd (`com.hypnodroid.mindmeld-sync`)
- **Linux** — a systemd user timer; `mindmeld start` / `mindmeld stop` control it.
  Unit files: [LINUX.md](LINUX.md#systemd-user-timer--mind-the-toolchain-path)
- **Ad hoc** — `pnpm run sync`

On a Linux host where Ollama is local there is no proxy in the path, so you can
restore a containerized sync if you prefer — `docker-compose.local.yml` still
defines one.

This is also why there is no `docker logs mindmeld-sync`: check the host process's
logs (`journalctl --user -u mindmeld-sync`, or launchd's log file) instead.

---

## What gets indexed

| Source | macOS | Linux |
| --- | --- | --- |
| Claude Code | `~/.claude` | `~/.claude` |
| Cursor | `~/Library/Application Support/Cursor/User/globalStorage` | `~/.config/Cursor/User/globalStorage` |

Only what is **currently on disk**. Claude Code rotates old transcripts away, so
a fresh machine usually holds only a handful of sessions; the index is the
durable archive from the day you start syncing forward.

Anything else can be pushed in over `POST /api/ingest` — see
[openapi.yaml](openapi.yaml) and [huddle-isolation.md](huddle-isolation.md).

---

## Configuration

Most macOS users need no `.env`. Copy `.env.example` and uncomment what you need.

```bash
# Ports (defaults chosen to avoid conflicts)
POSTGRES_PORT=5433
CHROMA_PORT=8001
MCP_HTTP_PORT=3847

# Database — must match on every machine feeding one shared index
POSTGRES_PASSWORD=mindmeld

# Ollama — two endpoints, see Prerequisites
OLLAMA_URL=http://192.168.1.100:11434
OLLAMA_EMBEDDING_URL=http://192.168.1.100:21434
OLLAMA_MAX_CONCURRENCY=1        # over an SSH tunnel, keep this at 1

# Models
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIMENSIONS=1024
SUMMARIZE_MODEL=qwen3:8b

# Job cadence
SYNC_INTERVAL_SECONDS=3600      # host sync loop
CENTROID_INTERVAL_SECONDS=25200 # 7 hours
WARMUP_INTERVAL_SECONDS=21600   # 6 hours
```

### Changing the embedding model

Vectors from different models are not comparable, so the whole index must be
rebuilt:

```bash
ollama pull nomic-embed-text
# .env: EMBEDDING_MODEL=nomic-embed-text, EMBEDDING_DIMENSIONS=<model's dims>
pnpm run db:reset       # destroys everything
pnpm run sync
pnpm run sync:embeddings
```

---

## Compose files

| File | Use |
| --- | --- |
| `docker-compose.yml` | Default. Pulls published GHCR images. No `sync` service |
| `docker-compose.local.yml` | Builds from source, includes a containerized `sync`, requires explicit `DATA_DIR`/`POSTGRES_PASSWORD`/paths (it uses `${VAR:?}`, so it fails fast rather than defaulting) |
| `docker-compose.dev.yml` | Overlay that builds the images instead of pulling: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build` |

> The dev overlay still declares a `sync` service that the base file no longer
> has. Compose will happily create it from the overlay alone — with no
> environment or volumes, so it starts and fails. Add `--scale sync=0`, or drop
> that block, when using the overlay.

---

## Common operations

```bash
docker logs mindmeld-mcp -f          # MCP + REST requests
docker logs mindmeld-centroids -f    # centroid recomputation

docker compose pull && docker compose up -d   # update
docker compose down                            # stop, keep data
docker compose down -v                         # stop and DELETE all indexed data
```

**Bring `mcp` up first after an upgrade.** It is the only service that applies
migrations (`src/db/migrations.ts`); a newer sync writing against an older schema
fails.

**Keep the compose project name stable.** Volumes are named
`<project>_mindmeld-postgres` and `<project>_mindmeld-chroma`, and the project
name defaults to the directory name. Running from a renamed directory points at
fresh, empty volumes and looks exactly like data loss.

---

## Remote / multi-machine

Running the databases on one always-on host while laptops sync into it is the
intended topology — SSH tunnels, `.env` for the remote machines, timers, and the
upgrade ordering are all covered in **[MULTI-MACHINE.md](MULTI-MACHINE.md)**.

For access from outside the LAN, Cloudflare Tunnel:

```bash
# .env
CLOUDFLARE_TUNNEL_TOKEN=your-token-here
docker compose --profile tunnel up -d
```

Mindmeld has **no authentication of its own** — the tunnel (or your SSH
config) is the entire access control story, and `POST /api/ingest` accepts writes
from anything that can reach the port.

---

## Troubleshooting

### Search returns nothing, sync reported success

Dead embeddings, nearly always. Probe `:21434` (see
[Prerequisites](#prerequisites)), then check the backlog:

```bash
curl -s localhost:3847/status | jq '.pendingEmbeddings, .chroma'
```

A `convo-messages` count of 0 with a large `pendingEmbeddings.messages` means
vectorization never ran or wrote nulls.

### 404 on summarization

The summarizer model isn't present: `ollama pull qwen3:8b` (or whatever
`SUMMARIZE_MODEL` is).

### Connection refused to Ollama

`ollama serve`, or start Ollama.app. From a container on **native Docker Engine**,
`host.docker.internal` does not resolve without
`extra_hosts: ["host.docker.internal:host-gateway"]` —
see [LINUX.md](LINUX.md#hosting-the-docker-stack-on-native-linux). Also make sure
Ollama binds an interface the container can reach (`OLLAMA_HOST=0.0.0.0`), not
just `127.0.0.1`.

### Permission denied reading conversations

Docker Desktop on macOS: Settings → Resources → File Sharing → add `~/.claude`.

### Cursor conversations not syncing

Wrong path. The CLI reads `CURSOR_PATH`; `docker-compose.local.yml`'s bind mount
reads `CURSOR_GLOBALSTATE_PATH`. On Linux:

```bash
echo "CURSOR_GLOBALSTATE_PATH=~/.config/Cursor/User/globalStorage" >> .env
```

### Port already in use

```bash
POSTGRES_PORT=5434
CHROMA_PORT=8002
MCP_HTTP_PORT=3848
```

### Summaries are slow (~30s each)

You are running sync through Docker Desktop's network proxy. Move it to the host
— see [Where sync runs](#where-sync-runs). If Ollama is reached over an SSH
tunnel, also keep `OLLAMA_MAX_CONCURRENCY=1`: the tunnel, not the GPU, is the
bottleneck, and parallel requests each degrade to ~30s.
