#!/bin/zsh
# Estimate time remaining for embedding queue

db() {
  docker exec mindmeld-postgres psql -U mindmeld -d conversations -t -A -c "$1" 2>/dev/null | tr -d ' '
}

pending=$(db "
  SELECT COUNT(*) FROM messages m
  LEFT JOIN embeddings e ON e.message_id = m.id AND e.chroma_collection = 'convo-messages'
  LEFT JOIN embeddings skip ON skip.message_id = m.id AND skip.chroma_collection = 'UNEMBEDDABLE'
  WHERE m.content_text IS NOT NULL AND LENGTH(m.content_text) > 10 AND m.role != 'tool'
    AND e.id IS NULL AND skip.id IS NULL")

embedded=$(db "SELECT COUNT(*) FROM embeddings WHERE chroma_collection = 'convo-messages'")
skipped=$(db "SELECT COUNT(*) FROM embeddings WHERE chroma_collection = 'UNEMBEDDABLE'")
total=$(db "SELECT COUNT(*) FROM messages")

pending_sessions=$(db "
  SELECT COUNT(*) FROM sessions s
  LEFT JOIN embeddings e ON e.chroma_collection = 'convo-sessions' AND e.chroma_id = 'session-' || s.id::text
  WHERE s.message_count > 0 AND s.title != 'Warmup'
    AND (e.id IS NULL OR s.content_chars > COALESCE(e.content_chars_at_embed, 0) OR COALESCE(s.content_chars, 0) = 0)")

# Estimate throughput from recent embeddings (last hour)
recent_rate=$(db "
  SELECT COUNT(*) FROM embeddings
  WHERE chroma_collection = 'convo-messages'
    AND created_at > NOW() - INTERVAL '1 hour'")

rate_window="1h"

# If no recent activity, check last 24h
if [[ "$recent_rate" -eq 0 ]]; then
  daily_rate=$(db "
    SELECT COUNT(*) FROM embeddings
    WHERE chroma_collection = 'convo-messages'
      AND created_at > NOW() - INTERVAL '24 hours'")
  if (( daily_rate > 0 )); then
    recent_rate=$(( daily_rate / 24 ))
  fi
  rate_window="24h avg"
fi

# Calculate ETA
total_embeddable=$(( embedded + pending ))
if (( total_embeddable > 0 )); then
  pct=$(( embedded * 100 / total_embeddable ))
else
  pct=100
fi

if (( recent_rate > 0 )); then
  eta_mins=$(( (pending * 60) / recent_rate ))
  eta_hours=$(( eta_mins / 60 ))
  if (( eta_hours > 0 )); then
    eta="${eta_hours}h $(( eta_mins % 60 ))m"
  else
    eta="${eta_mins}m"
  fi
else
  eta="stalled (no recent activity)"
fi

echo "=== Mindmeld Embedding Queue ==="
echo ""
echo "Messages:  ${embedded} embedded / ${pending} pending / ${skipped} skipped / ${total} total"
echo "Sessions:  ${pending_sessions} pending"
echo "Progress:  ${pct}%"
echo "Rate:      ${recent_rate}/hr (${rate_window})"
echo "ETA:       ${eta}"
