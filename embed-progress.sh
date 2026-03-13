#!/bin/zsh
# Embedding backfill progress monitor

SHORT_Q="SELECT COUNT(*) FROM messages m LEFT JOIN embeddings e ON m.id = e.message_id AND e.chroma_collection = 'convo-messages' LEFT JOIN embeddings skip ON skip.message_id = m.id AND skip.chroma_collection = 'UNEMBEDDABLE' WHERE e.id IS NULL AND skip.id IS NULL AND m.role != 'tool' AND m.content_text IS NOT NULL AND LENGTH(m.content_text) > 10 AND LENGTH(m.content_text) <= 8000;"
LONG_Q="SELECT COUNT(*) FROM messages m LEFT JOIN embeddings e ON m.id = e.message_id AND e.chroma_collection = 'convo-messages' LEFT JOIN embeddings skip ON skip.message_id = m.id AND skip.chroma_collection = 'UNEMBEDDABLE' WHERE e.id IS NULL AND skip.id IS NULL AND m.role != 'tool' AND m.content_text IS NOT NULL AND LENGTH(m.content_text) > 8000;"
DONE_Q="SELECT COUNT(*) FROM embeddings WHERE failure_reason IS NULL;"
RATE_Q="SELECT COUNT(*) FROM embeddings WHERE created_at > NOW() - INTERVAL '1 hour';"
LAST_Q="SELECT EXTRACT(EPOCH FROM NOW() - MAX(created_at))::int FROM embeddings;"

COLS=$(tput cols 2>/dev/null || echo 80)
BAR_WIDTH=$((COLS - 50))
[[ $BAR_WIDTH -lt 20 ]] && BAR_WIDTH=20

psql_q() { docker exec mindmeld-postgres psql -U mindmeld -d conversations -t -c "$1" 2>/dev/null | tr -d ' '; }

clear
echo "  Mindmeld Embedding Progress"
echo "  $(printf '%.0s─' {1..$((COLS - 4))})"
printf '\n\n\n\n\n\n'

while true; do
  SHORT=$(psql_q "$SHORT_Q")
  LONG=$(psql_q "$LONG_Q")
  DONE=$(psql_q "$DONE_Q")
  RATE=$(psql_q "$RATE_Q")
  LAST_AGO=$(psql_q "$LAST_Q")
  PENDING=$((SHORT + LONG))
  TOTAL=$((DONE + PENDING))

  PCT=$((DONE * 100 / TOTAL))
  FILLED=$((PCT * BAR_WIDTH / 100))
  EMPTY=$((BAR_WIDTH - FILLED))

  BAR=$(printf '%0.s█' $(seq 1 $FILLED 2>/dev/null))
  [[ $EMPTY -gt 0 ]] && BAR+=$(printf '%0.s░' $(seq 1 $EMPTY 2>/dev/null))

  # ETA based on last hour rate
  if [[ $RATE -gt 0 ]]; then
    RATE_MIN=$(echo "scale=1; $RATE / 60" | bc)
    ETA_MIN=$(echo "scale=0; $PENDING * 60 / $RATE" | bc 2>/dev/null)
    ETA_HR=$((ETA_MIN / 60))
    ETA_REM=$((ETA_MIN % 60))
    [[ $ETA_HR -gt 0 ]] && ETA_STR="${ETA_HR}h${ETA_REM}m" || ETA_STR="${ETA_MIN}m"
  else
    RATE_MIN="0"
    ETA_STR="--"
  fi

  # Last embed age
  if [[ $LAST_AGO -lt 60 ]]; then
    AGO_STR="${LAST_AGO}s ago"
  elif [[ $LAST_AGO -lt 3600 ]]; then
    AGO_STR="$((LAST_AGO / 60))m ago"
  else
    AGO_STR="$((LAST_AGO / 3600))h ago"
  fi

  printf "\033[6A"
  printf "  %s %3d%%\n" "$BAR" "$PCT"
  printf "  %-${COLS}s\n" "Done: $DONE  Pending: $PENDING"
  printf "  %-${COLS}s\n" "  Short (fast): $SHORT   Long (summarize): $LONG"
  printf "  %-${COLS}s\n" "Rate: ${RATE}/hr (~${RATE_MIN}/min)  ETA: $ETA_STR"
  printf "  %-${COLS}s\n" "Last embed: $AGO_STR"
  printf "  %-${COLS}s\n" "$(date '+%H:%M:%S')"

  [[ $PENDING -eq 0 ]] && echo "\n  Done!" && break
  sleep 30
done
