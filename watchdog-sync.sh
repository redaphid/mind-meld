#!/bin/zsh
# Watchdog: restarts mindmeld-sync if the last embed is stale and there's pending work.
# Intended to run via cron every 10 minutes.
# Prevents the "ollama was down, sync sleeps for an hour" stall.

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:$PATH"

LOGFILE="$(dirname $0)/watchdog.log"

LAST_Q="SELECT EXTRACT(EPOCH FROM NOW() - MAX(created_at))::int FROM embeddings;"
PENDING_Q="SELECT COUNT(*) FROM messages m LEFT JOIN embeddings e ON m.id = e.message_id AND e.chroma_collection = 'convo-messages' LEFT JOIN embeddings skip ON skip.message_id = m.id AND skip.chroma_collection = 'UNEMBEDDABLE' WHERE e.id IS NULL AND skip.id IS NULL AND m.role <> 'tool' AND m.content_text IS NOT NULL AND LENGTH(m.content_text) > 10;"

psql_q() { docker exec mindmeld-postgres psql -U mindmeld -d conversations -t -c "$1" 2>/dev/null | tr -d ' ' }

LAST_AGO=$(psql_q "$LAST_Q")
PENDING=$(psql_q "$PENDING_Q")

[[ -z "$LAST_AGO" || -z "$PENDING" ]] && exit 0
[[ "$PENDING" -eq 0 ]] && exit 0
[[ "$LAST_AGO" -lt 1200 ]] && exit 0

# Stale (>20 min) with pending work — check deps before restarting
curl -sf http://localhost:11434/api/version > /dev/null 2>&1 || exit 0
docker exec mindmeld-postgres pg_isready -U mindmeld -d conversations > /dev/null 2>&1 || exit 0

docker restart mindmeld-sync > /dev/null 2>&1
echo "$(date -Iseconds) watchdog: restarted mindmeld-sync (stale ${LAST_AGO}s, ${PENDING} pending)" >> "$LOGFILE"
