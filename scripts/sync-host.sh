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
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5433
export CHROMA_HOST=localhost
export CHROMA_PORT=8001
export OLLAMA_URL=http://localhost:11434
export OLLAMA_EMBEDDING_URL=http://localhost:21434

INTERVAL="${SYNC_INTERVAL_SECONDS:-3600}"
while true; do
  pnpm run sync || echo "sync cycle failed; retrying next interval"
  echo "=== Sync complete, sleeping ${INTERVAL}s ==="
  sleep "${INTERVAL}"
done
