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

# Point at the published DB ports. dotenv does not override already-set vars,
# so these win over the in-container hostnames baked into .env.
#
# 127.0.0.1, never `localhost`: these services bind IPv4 only, so a `localhost`
# that resolves to ::1 first fails against a server that is up and healthy.
export POSTGRES_HOST=127.0.0.1
export POSTGRES_PORT=5433
export CHROMA_HOST=127.0.0.1
export CHROMA_PORT=8001

# OLLAMA_URL is deliberately NOT exported. config.ts already defaults it to the
# same host-shaped value, and exporting it only shadowed .env — leaving no way
# to aim this worker at a local Ollama when the tunnel on 11434 is down.
#
# The catch: .env's OLLAMA_URL is shared with docker-compose, where the default
# is container-shaped (host.docker.internal). That name does not resolve on the
# host, and every summarization would fail one connection error at a time for
# as long as the loop runs. Refuse to start instead.
case "${OLLAMA_URL:-}" in
  *docker.internal*)
    echo "sync-host: OLLAMA_URL=${OLLAMA_URL} is container-shaped; the host cannot resolve it." >&2
    echo "sync-host: set a host-reachable URL (e.g. http://127.0.0.1:11435) in .env." >&2
    exit 1
    ;;
esac

INTERVAL="${SYNC_INTERVAL_SECONDS:-3600}"
while true; do
  pnpm run sync || echo "sync cycle failed; retrying next interval"
  echo "=== Sync complete, sleeping ${INTERVAL}s ==="
  sleep "${INTERVAL}"
done
