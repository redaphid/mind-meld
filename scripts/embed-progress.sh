#!/bin/zsh
# Mindmeld indexing progress monitor — tracks both message vectors and session summaries.

SHORT_Q="SELECT COUNT(*) FROM messages m LEFT JOIN embeddings e ON m.id = e.message_id AND e.chroma_collection = 'convo-messages' LEFT JOIN embeddings skip ON skip.message_id = m.id AND skip.chroma_collection = 'UNEMBEDDABLE' WHERE e.id IS NULL AND skip.id IS NULL AND m.role <> 'tool' AND m.content_text IS NOT NULL AND LENGTH(m.content_text) > 10 AND LENGTH(m.content_text) <= 8000;"
LONG_Q="SELECT COUNT(*) FROM messages m LEFT JOIN embeddings e ON m.id = e.message_id AND e.chroma_collection = 'convo-messages' LEFT JOIN embeddings skip ON skip.message_id = m.id AND skip.chroma_collection = 'UNEMBEDDABLE' WHERE e.id IS NULL AND skip.id IS NULL AND m.role <> 'tool' AND m.content_text IS NOT NULL AND LENGTH(m.content_text) > 8000;"
DONE_Q="SELECT COUNT(*) FROM embeddings WHERE failure_reason IS NULL;"
RATE_Q="SELECT COUNT(*) FROM embeddings WHERE created_at > NOW() - INTERVAL '1 hour';"
LAST_Q="SELECT EXTRACT(EPOCH FROM NOW() - MAX(created_at))::int FROM embeddings;"
SUMM_DONE_Q="SELECT COUNT(*) FROM sessions WHERE summary IS NOT NULL AND message_count > 0 AND title != 'Warmup' AND deleted_at IS NULL;"
SUMM_MISSING_Q="SELECT COUNT(*) FROM sessions WHERE summary IS NULL AND message_count > 0 AND title != 'Warmup' AND deleted_at IS NULL;"
SUMM_RATE_Q="SELECT COUNT(*) FROM embeddings WHERE chroma_collection = 'convo-sessions' AND created_at > NOW() - INTERVAL '1 hour';"

COLS=$(tput cols 2>/dev/null || echo 80)
BAR_WIDTH=$((COLS - 50))
[[ $BAR_WIDTH -lt 20 ]] && BAR_WIDTH=20

psql_q() { docker exec mindmeld-postgres psql -U mindmeld -d conversations -t -c "$1" 2>/dev/null | tr -d ' '; }

make_bar() {
  local pct=$1 filled empty bar=""
  filled=$((pct * BAR_WIDTH / 100))
  empty=$((BAR_WIDTH - filled))
  [[ $filled -gt 0 ]] && bar=$(printf '%0.s█' $(seq 1 $filled))
  [[ $empty -gt 0 ]] && bar+=$(printf '%0.s░' $(seq 1 $empty))
  printf '%s' "$bar"
}

fmt_eta() {
  local pending=$1 rate=$2 m h r
  [[ $rate -le 0 ]] && { printf '%s' "--"; return; }
  m=$(echo "scale=0; $pending * 60 / $rate" | bc 2>/dev/null)
  h=$((m / 60)); r=$((m % 60))
  [[ $h -gt 0 ]] && printf '%s' "${h}h${r}m" || printf '%s' "${m}m"
}

clear
echo "  Mindmeld Indexing Progress"
echo "  $(printf '%.0s─' {1..$((COLS - 4))})"
printf '\n\n\n\n\n\n'

while true; do
  SHORT=$(psql_q "$SHORT_Q")
  LONG=$(psql_q "$LONG_Q")
  DONE=$(psql_q "$DONE_Q")
  RATE=$(psql_q "$RATE_Q")
  LAST_AGO=$(psql_q "$LAST_Q")
  SUMM_DONE=$(psql_q "$SUMM_DONE_Q")
  SUMM_MISSING=$(psql_q "$SUMM_MISSING_Q")
  SUMM_RATE=$(psql_q "$SUMM_RATE_Q")

  PENDING=$((SHORT + LONG))
  VEC_TOTAL=$((DONE + PENDING))
  SUMM_TOTAL=$((SUMM_DONE + SUMM_MISSING))
  [[ $VEC_TOTAL -gt 0 ]] && VEC_PCT=$((DONE * 100 / VEC_TOTAL)) || VEC_PCT=100
  [[ $SUMM_TOTAL -gt 0 ]] && SUMM_PCT=$((SUMM_DONE * 100 / SUMM_TOTAL)) || SUMM_PCT=100

  VEC_BAR=$(make_bar $VEC_PCT)
  SUMM_BAR=$(make_bar $SUMM_PCT)
  VEC_ETA=$(fmt_eta $PENDING $RATE)
  SUMM_ETA=$(fmt_eta $SUMM_MISSING $SUMM_RATE)

  if [[ $LAST_AGO -lt 60 ]]; then
    AGO_STR="${LAST_AGO}s ago"
  elif [[ $LAST_AGO -lt 3600 ]]; then
    AGO_STR="$((LAST_AGO / 60))m ago"
  else
    AGO_STR="$((LAST_AGO / 3600))h ago"
  fi

  printf "\033[6A"
  printf "  %-10s %s %3d%%\033[K\n" "Vectors" "$VEC_BAR" "$VEC_PCT"
  printf "  %-10s %s %3d%%\033[K\n" "Summaries" "$SUMM_BAR" "$SUMM_PCT"
  printf "  %s\033[K\n" "Vectors:   $DONE done · $PENDING pending ($SHORT short, $LONG long) · ${RATE}/hr · ETA $VEC_ETA"
  printf "  %s\033[K\n" "Summaries: $SUMM_DONE done · $SUMM_MISSING missing · ${SUMM_RATE}/hr · ETA $SUMM_ETA"
  printf "  %s\033[K\n" "Last embed: $AGO_STR"
  printf "  %s\033[K\n" "$(date '+%H:%M:%S')"

  [[ $PENDING -eq 0 && $SUMM_MISSING -eq 0 ]] && echo "\n  Done!" && break
  sleep 30
done
