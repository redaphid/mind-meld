#!/usr/bin/env bash
# Drives mindmeld's Ollama-backed sync (embeddings + summarization) only while
# the GPU is otherwise idle, and kills an in-flight sync if something else
# (a game, a GPU-heavy app) starts using it. Applies to both the Windows-path
# and WSL-native sync containers, since both share the same physical GPU
# through WSL's GPU passthrough (nvidia-smi here reports real combined usage).
set -uo pipefail

POLL_INTERVAL=30      # seconds between GPU checks
IDLE_THRESHOLD=15     # % util below this counts as "idle"
BUSY_THRESHOLD=30     # % util at/above this kills an in-flight sync
IDLE_STREAK_NEEDED=3  # consecutive idle polls before starting a sync (~90s)
MIN_GAP=120           # minimum seconds between sync attempts per container

CONTAINERS=(mindmeld-sync mindmeld-sync-wsl)
STATE_DIR="$HOME/.local/share/mindmeld/gpu-gate"
mkdir -p "$STATE_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

gpu_util() {
  nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1
}

is_running() { [[ -f "$STATE_DIR/$1.lock" ]]; }
last_sync()  { cat "$STATE_DIR/$1.last" 2>/dev/null || echo 0; }

run_sync() {
  local c=$1
  touch "$STATE_DIR/$c.lock"
  log "GPU idle - starting sync on $c"
  docker exec "$c" /app/mindmeld sync >>"$STATE_DIR/$c.log" 2>&1
  date +%s > "$STATE_DIR/$c.last"
  rm -f "$STATE_DIR/$c.lock"
  log "sync finished on $c"
}

idle_streak=0
log "gpu-gated-sync starting (poll=${POLL_INTERVAL}s idle<${IDLE_THRESHOLD}% busy>=${BUSY_THRESHOLD}%)"

while true; do
  util=$(gpu_util)
  if [[ -z "$util" ]]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  if (( util >= BUSY_THRESHOLD )); then
    idle_streak=0
    for c in "${CONTAINERS[@]}"; do
      if is_running "$c"; then
        log "GPU busy (${util}%) - stopping in-flight sync on $c"
        docker exec "$c" pkill -f "mindmeld sync" 2>/dev/null
        rm -f "$STATE_DIR/$c.lock"
      fi
    done
  elif (( util < IDLE_THRESHOLD )); then
    idle_streak=$((idle_streak + 1))
  else
    idle_streak=0
  fi

  if (( idle_streak >= IDLE_STREAK_NEEDED )); then
    now=$(date +%s)
    for c in "${CONTAINERS[@]}"; do
      if ! is_running "$c" && (( now - $(last_sync "$c") >= MIN_GAP )); then
        run_sync "$c" &
      fi
    done
  fi

  sleep "$POLL_INTERVAL"
done
