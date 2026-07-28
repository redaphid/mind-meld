# Multi-Machine Setup — One Shared Brain

Mindmeld is designed to run as **one central index** ("the brain") that many
machines feed into and query. You run the full stack (Postgres + Chroma + MCP +
sync) on a single always-on **host**, and every other machine (laptops, other
desktops) connects to it — writing its own Claude Code / Cursor conversations in,
and reading the merged index back out.

```
                        ┌──────────────────── host (always-on) ────────────────────┐
                        │  Docker compose project "mind-meld"                       │
                        │                                                           │
  laptop A ── ssh ──┐   │   mindmeld-postgres :5433   mindmeld-chroma :8001         │
  laptop B ── ssh ──┼──▶│   mindmeld-mcp :3847        sync / centroids / warmups    │
  desktop C ─ ssh ──┘   │                                                           │
                        │   ollama :11434 (generation)   ollama :21434 (embeddings) │
                        └───────────────────────────────────────────────────────────┘
        each machine's ~/.claude  ─────sync────▶  one `conversations` DB + `convo-*` collections
```

Everything below is in addition to the single-host [Docker Setup](DOCKER.md).

---

## The two-Ollama requirement

Mindmeld talks to **two** Ollama endpoints, and they should be separate:

| Env var                | Default                        | Purpose                                   |
| ---------------------- | ------------------------------ | ----------------------------------------- |
| `OLLAMA_URL`           | `http://localhost:11434`       | Generation / summaries (`qwen3…`)         |
| `OLLAMA_EMBEDDING_URL` | `http://localhost:21434`       | Vectorization (`bge-m3`, 1024-dim)        |

Why two: **`bge-m3` returns all-null embeddings when Ollama flash attention is
ON**, which silently breaks semantic search. Generation benefits from flash
attention. So run a dedicated embedding Ollama with flash attention **off**:

```bash
OLLAMA_FLASH_ATTENTION=0 OLLAMA_HOST=127.0.0.1:21434 ollama serve
ollama pull bge-m3   # into that instance
```

> ⚠️ `OLLAMA_EMBEDDING_URL` does **not** fall back to `OLLAMA_URL`. If you leave it
> unset, mindmeld uses the default `localhost:21434`; if nothing is listening
> there, sync produces **zero** embeddings while otherwise appearing to succeed.
> Verify any embedding endpoint before trusting it:
> ```bash
> curl -s localhost:21434/api/embed -d '{"model":"bge-m3","input":"probe"}' \
>   | head -c 80   # expect a long non-null "embeddings":[[...]] array
> ```

If you genuinely can't run a second instance and your main Ollama has flash
attention off, you may point `OLLAMA_EMBEDDING_URL` at `:11434` — but confirm the
probe above returns non-null vectors first.

---

## Connecting a remote machine (no Docker required)

A machine that only wants to **contribute + query** does not need Docker or its
own database — it runs mindmeld's Node app directly against the host's services.

### 1. Reach the host's services

Expose (or SSH-tunnel) these host ports to the remote machine's `localhost`:

| Port    | Service                         |
| ------- | ------------------------------- |
| `5433`  | mindmeld-postgres               |
| `8001`  | mindmeld-chroma                 |
| `3847`  | mindmeld-mcp (read/query API)   |
| `11434` | generation Ollama               |
| `21434` | embedding Ollama                |

With SSH, a persistent tunnel does it (run under systemd so it self-heals):

```sshconfig
# ~/.ssh/config
Host brain-tunnel
  HostName your-host.example.com
  User you
  LocalForward 5433  localhost:5433
  LocalForward 8001  localhost:8001
  LocalForward 3847  localhost:3847
  LocalForward 11434 localhost:11434
  LocalForward 21434 localhost:21434
  RequestTTY no
  ServerAliveInterval 60
  ServerAliveCountMax 3
```
```ini
# ~/.config/systemd/user/brain-tunnel.service
[Unit]
Description=SSH tunnel to the mindmeld brain
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/bin/ssh -N -T brain-tunnel
Restart=always
RestartSec=30
[Install]
WantedBy=default.target
```
```bash
systemctl --user enable --now brain-tunnel.service
loginctl enable-linger "$USER"    # so it starts at boot without a login session
```

### 2. Configure and install

Clone the repo, then create `.env` pointing at the forwarded ports. **Use the
same `POSTGRES_DB` (`conversations`) and models as the host** so your data merges
into the one index instead of forking it (the `convo-*` Chroma collection names
are fixed in `src/config.ts`, so they already match):

```bash
# .env on the remote machine
POSTGRES_HOST=localhost
POSTGRES_PORT=5433
POSTGRES_USER=mindmeld
POSTGRES_PASSWORD=mindmeld          # match the host
POSTGRES_DB=conversations

CHROMA_HOST=localhost
CHROMA_PORT=8001

OLLAMA_URL=http://localhost:11434
OLLAMA_EMBEDDING_URL=http://localhost:21434
OLLAMA_MAX_CONCURRENCY=1            # a tunnel saturates fast; serialize it
OLLAMA_TIMEOUT_MS=300000

EMBEDDING_MODEL=bge-m3
EMBEDDING_DIMENSIONS=1024
SUMMARIZE_MODEL=qwen3:4b-instruct   # match the host's summarizer

CLAUDE_CODE_PATH=~/.claude
```

```bash
pnpm install
pnpm run sync         # first sync writes this machine's conversations into the brain
```

> **Schema note:** migrations only run in the **MCP** container on startup, never
> in the sync CLI. A remote machine running a newer mindmeld than the host can
> write rows the host's schema lacks and fail. Keep the host on the **newest**
> version, or match the remote to the host's version.

### 3. Automate the sync (hourly)

The remote machine's conversations are only its own — nothing else indexes them —
so run its sync on a timer:

```bash
# ~/.local/bin/mindmeld-sync.sh
#!/usr/bin/env bash
set -euo pipefail
cd /path/to/mind-meld
exec ./node_modules/.bin/tsx src/index.ts sync
```
```ini
# ~/.config/systemd/user/mindmeld-sync.service
[Unit]
Description=Mindmeld sync -> shared brain
After=brain-tunnel.service
Wants=brain-tunnel.service
[Service]
Type=oneshot
ExecStart=%h/.local/bin/mindmeld-sync.sh
TimeoutStartSec=1800
```
```ini
# ~/.config/systemd/user/mindmeld-sync.timer
[Unit]
Description=Run mindmeld sync hourly
[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=120
[Install]
WantedBy=timers.target
```
```bash
systemctl --user daemon-reload
systemctl --user enable --now mindmeld-sync.timer
```

> Use `OnCalendar=hourly`, not `OnBootSec`+`OnUnitActiveSec`. The latter has no
> anchor for a unit that has never run and silently shows `NEXT: n/a` (never fires).

### 4. Connect Claude Code (read side) at user scope

Register the host's MCP once, **user scope** so it's available in every project:

```bash
claude mcp add --scope user --transport http mindmeld http://localhost:3847/mcp
claude mcp get mindmeld     # -> Scope: User config, Status: Connected
```

Then ask Claude *"what was I working on yesterday?"* from any repo.

---

## Upgrading the central stack

Follow the host update in [DOCKER.md](DOCKER.md) (`docker compose pull && up -d`),
plus:

- **Set `OLLAMA_EMBEDDING_URL` before upgrading.** Older deployments that embedded
  via `:11434` and never set it will, after upgrade, default to the dead
  `localhost:21434` and stop embedding. Add it to the `sync`, `centroid-compute`,
  and `mcp` services (they're the ones that embed).
- **Preserve the data volumes.** Compose names them `<project>_mindmeld-postgres`
  and `<project>_mindmeld-chroma`. Always bring the stack up with the **same
  compose project name** (default = the directory name). A different project name
  points at fresh, empty volumes and appears to wipe the brain.
- Bring **`mcp` up first** so it applies migrations before the new `sync`
  container writes rows that depend on them.

---

## Host-on-Windows (Docker Desktop + WSL) gotchas

If the host is Windows with Docker Desktop and you drive it from WSL over SSH:

- **Volume paths:** the WSL docker CLI rejects `C:\Users\...` volume specs. Use
  the WSL form `/mnt/c/Users/<you>/.claude` for bind mounts (e.g. the `sync`
  container's `CLAUDE_CODE_PATH`). Docker Desktop translates it back to the host.
- **`host.docker.internal`** works without `extra_hosts` (Docker Desktop provides
  it). On native Linux hosts you must add `extra_hosts: ["host.docker.internal:host-gateway"]`.
- **Credential helper:** `docker compose pull` may fail with
  `docker-credential-desktop.exe not found`. For public GHCR images, `docker pull
  <image>` directly works, or add Docker Desktop's `resources/bin` to `PATH`.
- **zsh quoting:** in zsh, `$img:latest` triggers the `:l` (lowercase) modifier
  and mangles the tag. Brace it: `${img}:latest`.

---

## "Why does the brain look small / where are my conversations?"

Sync only ingests what is **currently on disk** in each machine's
`~/.claude/projects`. Claude Code rotates old transcripts off disk over time, so a
single machine usually holds only a handful. The shared brain is the **durable
archive going forward** — once a conversation is synced it stays even after it
ages off local disk.

To grow the history, **every machine you work on needs the remote setup above**
(tunnel + `.env` + `mindmeld-sync.timer`), all writing the same `conversations`
DB and `convo-*` collections. One machine's sync never sees another's transcripts.
