#!/bin/bash

# Mindmeld Health Check - sends macOS notification on failure

# Add homebrew to PATH for launchd
export PATH="/opt/homebrew/bin:$PATH"

CONTAINER="mindmeld-sync"
POSTGRES_CONTAINER="mindmeld-postgres"

# Check if sync container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    osascript -e 'display notification "Sync container is not running!" with title "Mindmeld Alert" sound name "Basso"'
    exit 1
fi

# Check if postgres is healthy
if ! docker exec $POSTGRES_CONTAINER pg_isready -U mindmeld -d conversations > /dev/null 2>&1; then
    osascript -e 'display notification "Postgres is not responding!" with title "Mindmeld Alert" sound name "Basso"'
    exit 1
fi

# Check embedding progress - get count from last hour
RECENT_EMBEDDINGS=$(docker exec $POSTGRES_CONTAINER psql -U mindmeld -d conversations -t -c "
SELECT COUNT(*) FROM embeddings WHERE created_at > NOW() - INTERVAL '1 hour'
" 2>/dev/null | tr -d ' ')

# Check if embedding is stalled (less than 10 new embeddings in last hour during active sync)
CONTAINER_UPTIME=$(docker inspect --format='{{.State.StartedAt}}' $CONTAINER 2>/dev/null)
if [[ -n "$CONTAINER_UPTIME" ]] && [[ "$RECENT_EMBEDDINGS" -lt 10 ]]; then
    # Check if there are pending embeddings
    PENDING=$(docker exec $POSTGRES_CONTAINER psql -U mindmeld -d conversations -t -c "
    SELECT COUNT(*) FROM messages m LEFT JOIN embeddings e ON e.message_id = m.id WHERE e.id IS NULL
    " 2>/dev/null | tr -d ' ')
    
    if [[ "$PENDING" -gt 1000 ]]; then
        osascript -e "display notification \"Embedding stalled! $PENDING pending, only $RECENT_EMBEDDINGS in last hour\" with title \"Mindmeld Alert\" sound name \"Basso\""
        exit 1
    fi
fi

# Check for errors in recent logs
if docker logs --since 10m $CONTAINER 2>&1 | grep -qi "error\|failed\|exception"; then
    ERROR_MSG=$(docker logs --since 10m $CONTAINER 2>&1 | grep -i "error\|failed\|exception" | tail -1 | cut -c1-100)
    osascript -e "display notification \"$ERROR_MSG\" with title \"Mindmeld Error\" sound name \"Basso\""
fi

echo "Health check passed - $RECENT_EMBEDDINGS embeddings in last hour"
