#!/usr/bin/env bash
# Run the mindmeld sync loop as a HOST process (not in Docker).
#
# Why: Docker Desktop for Mac's container network proxy (gvisor/vpnkit)
# backpressures Ollama's response stream, turning ~3s summaries into ~30s. The
# Mac host reaches the same Ollama (over the same SSH tunnel) in ~1.6s. So the
# sync worker runs here on the host while Postgres/Chroma stay in Docker, reached
# via their published ports. Measured: chunk summaries dropped ~30s -> ~3s.
set -uo pipefail
cd "$(dirname "$0")/.."

# Point at the published host ports. dotenv does not override already-set vars,
# so these win over the in-container hostnames baked into .env.
#
# 127.0.0.1, never `localhost`: Ollama binds IPv4 only (127.0.0.1:11434, nothing
# on ::1), so a `localhost` that resolves to IPv6 first fails against a server
# that is up and healthy. Same literal for the DB ports, for the same reason.
export POSTGRES_HOST=127.0.0.1
export POSTGRES_PORT=5433
export CHROMA_HOST=127.0.0.1
export CHROMA_PORT=8001
export OLLAMA_URL=http://127.0.0.1:11434

INTERVAL="${SYNC_INTERVAL_SECONDS:-3600}"
while true; do
  pnpm run sync || echo "sync cycle failed; retrying next interval"
  echo "=== Sync complete, sleeping ${INTERVAL}s ==="
  sleep "${INTERVAL}"
done
