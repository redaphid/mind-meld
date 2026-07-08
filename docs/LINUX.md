# Linux Installation Tips

Mindmeld runs fine on Linux, but a few defaults are macOS-oriented. This covers
both **hosting the stack on Linux** and **running the sync/query app on a Linux
machine** that feeds a remote brain (see [MULTI-MACHINE.md](MULTI-MACHINE.md)).

## Paths

Set the Cursor path (the default is the macOS location). Claude Code is the same
on both:

```bash
# .env
CLAUDE_CODE_PATH=~/.claude                              # same as macOS
CURSOR_GLOBALSTATE_PATH=~/.config/Cursor/User/globalStorage
```

If you don't use Cursor, point `CURSOR_GLOBALSTATE_PATH` at any existing empty
directory so the Docker bind mount / copy step doesn't error.

## Ollama on Linux

Install and enable Ollama, then pull the models mindmeld uses:

```bash
curl -fsSL https://ollama.com/install.sh | sh
systemctl enable --now ollama
ollama pull qwen3:4b-instruct   # summaries (SUMMARIZE_MODEL)
ollama pull bge-m3              # embeddings (EMBEDDING_MODEL, 1024-dim)
```

### Dedicated embedding instance (flash attention off)

`bge-m3` returns **all-null embeddings when flash attention is ON**. If your main
Ollama has it on for generation speed, run a second, flash-off instance for
embeddings on `21434` and point `OLLAMA_EMBEDDING_URL` at it:

```ini
# ~/.config/systemd/user/ollama-embed.service   (or a system unit)
[Unit]
Description=Ollama (embeddings, flash attention off)
[Service]
Environment=OLLAMA_HOST=127.0.0.1:21434
Environment=OLLAMA_FLASH_ATTENTION=0
Environment=OLLAMA_KEEP_ALIVE=-1
ExecStart=/usr/local/bin/ollama serve
Restart=always
[Install]
WantedBy=default.target
```
```bash
systemctl --user enable --now ollama-embed.service
OLLAMA_HOST=127.0.0.1:21434 ollama pull bge-m3
# verify non-null:
curl -s localhost:21434/api/embed -d '{"model":"bge-m3","input":"probe"}' | head -c 80
```

If your main Ollama already has flash attention **off**, you can skip this and set
`OLLAMA_EMBEDDING_URL=http://localhost:11434` — but run the probe above first.

## Hosting the Docker stack on native Linux

On **Docker Engine** (not Docker Desktop), `host.docker.internal` does **not**
resolve by default, so containers can't reach host Ollama. Add a host-gateway
mapping to every service that talks to Ollama (`sync`, `centroid-compute`, `mcp`):

```yaml
services:
  sync:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Alternatives: point `OLLAMA_URL`/`OLLAMA_EMBEDDING_URL` at the docker bridge gateway
(`http://172.17.0.1:11434`), or run the container with `network_mode: host` and use
`http://localhost:11434`. Make sure Ollama is bound to an interface the container
can reach (`OLLAMA_HOST=0.0.0.0` or the bridge IP), not just `127.0.0.1`.

## Running the Node app directly on Linux (no Docker)

A machine that only contributes/queries can run the app itself. Requirements:
**Node ≥ 20** and **pnpm** (a `preinstall` hook enforces pnpm via `only-allow`).

```bash
corepack enable            # or install pnpm however you prefer
pnpm install
pnpm run sync
```

### systemd user timer — mind the toolchain path

If you manage Node with **fnm/nvm/asdf**, the `node` on your interactive `PATH` is
a shell-scoped shim that does **not** exist for systemd. Resolve a stable absolute
path in the wrapper the service runs:

```bash
# ~/.local/bin/mindmeld-sync.sh
#!/usr/bin/env bash
set -euo pipefail
# newest fnm-managed node (adjust for nvm/asdf); robust across version bumps
NODE_BIN="$(ls -d "$HOME"/.local/share/fnm/node-versions/*/installation/bin 2>/dev/null | sort -V | tail -1)"
export PATH="${NODE_BIN}:/usr/local/bin:/usr/bin:/bin"
cd /path/to/mind-meld
exec ./node_modules/.bin/tsx src/index.ts sync
```

Then a **user** service + timer (see [MULTI-MACHINE.md](MULTI-MACHINE.md) for the
unit files). Two Linux-specific notes:

- **Boot without login:** user units only run at boot after
  `loginctl enable-linger "$USER"`. Without it, the timer stops when you log out.
- **Timer schedule:** use `OnCalendar=hourly` + `Persistent=true`. A timer built
  only from `OnBootSec`+`OnUnitActiveSec` has no anchor until its service has run
  once and silently shows `NEXT: n/a` (never fires).

## Quick verification

```bash
systemctl --user status ollama-embed.service       # embeddings instance up
curl -s localhost:11434/api/tags | head -c 60       # generation reachable
curl -s localhost:3847/health                        # MCP: {"status":"ok",...}
systemctl --user list-timers mindmeld-sync.timer     # real NEXT time, not n/a
```
