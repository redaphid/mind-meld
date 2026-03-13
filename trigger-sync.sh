#!/bin/zsh
# Force-trigger a mindmeld sync by restarting the sync container.
# Also verifies dependencies (ollama, postgres) are reachable first.

check() {
  local name=$1 cmd=$2
  eval "$cmd" > /dev/null 2>&1 && return 0
  echo "ERROR: $name is not reachable" >&2
  return 1
}

check "Ollama" "curl -sf http://localhost:11434/api/version" || exit 1
check "Postgres" "docker exec mindmeld-postgres pg_isready -U mindmeld -d conversations" || exit 1

docker restart mindmeld-sync > /dev/null 2>&1
