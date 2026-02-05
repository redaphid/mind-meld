#!/bin/bash
set -euo pipefail

# Trigger the embedding self-healing loop.
# Applies migration, shows NaN-blocked stats, runs embeddings with retry logic.
#
# Usage:
#   ./scripts/heal-data.sh          # respect cooldown (default 7 days)
#   ./scripts/heal-data.sh --now    # bypass cooldown, retry immediately

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# Override Docker-internal hostnames for local execution
export POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
export POSTGRES_PORT="${POSTGRES_PORT:-5433}"
export CHROMA_HOST="${CHROMA_HOST:-localhost}"
export CHROMA_PORT="${CHROMA_PORT:-8001}"

# Resolve Docker hostnames to localhost (`.env` may have `postgres`/`chroma`/`host.docker.internal`)
[[ "$POSTGRES_HOST" == "postgres" ]] && export POSTGRES_HOST=localhost
[[ "$CHROMA_HOST" == "chroma" ]] && export CHROMA_HOST=localhost
export OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
[[ "$OLLAMA_URL" == *"host.docker.internal"* ]] && export OLLAMA_URL="http://localhost:11434"

PGHOST="$POSTGRES_HOST"
PGPORT="$POSTGRES_PORT"
PGUSER="${POSTGRES_USER:-mindmeld}"
PGDB="${POSTGRES_DB:-conversations}"
export PGPASSWORD="${POSTGRES_PASSWORD:-mindmeld}"

psql_cmd() {
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -tA "$@"
}

# 1. Apply pending migrations (idempotent — skips already-applied)
echo "Running migrations..."
pnpm run db:migrate

# 2. Pre-heal stats
echo ""
echo "=== Healing Stats ==="
psql_cmd -c "
  SELECT
    COALESCE(failure_reason, 'legacy-null') as reason,
    COUNT(*) as count,
    MIN(retry_count) as min_retries,
    MAX(retry_count) as max_retries
  FROM embeddings
  WHERE chroma_collection = 'UNEMBEDDABLE'
  GROUP BY failure_reason
  ORDER BY count DESC
" | while IFS='|' read -r reason count min_r max_r; do
  printf "  %-15s %6s rows  (retries: %s–%s)\n" "$reason" "$count" "$min_r" "$max_r"
done

ELIGIBLE=$(psql_cmd -c "
  SELECT COUNT(*) FROM embeddings
  WHERE chroma_collection = 'UNEMBEDDABLE' AND failure_reason = 'nan'
    AND retry_count < ${HEALING_RETRY_LIMIT:-3}
    AND updated_at < NOW() - make_interval(days => ${HEALING_COOLDOWN_DAYS:-7})
")
echo ""
echo "Eligible for retry (cooldown elapsed): $ELIGIBLE"

# 3. Override cooldown if --now
if [[ "${1:-}" == "--now" ]]; then
  echo ""
  echo "Bypassing cooldown — setting HEALING_COOLDOWN_DAYS=0"
  export HEALING_COOLDOWN_DAYS=0
fi

# 4. Run embeddings (picks up NaN-eligible messages via skip logic)
echo ""
echo "Running embedding pipeline..."
pnpm run sync:embeddings

# 5. Post-heal stats
echo ""
echo "=== Post-Heal Stats ==="
REMAINING_NAN=$(psql_cmd -c "
  SELECT COUNT(*) FROM embeddings
  WHERE chroma_collection = 'UNEMBEDDABLE' AND failure_reason = 'nan'
")
REMAINING_NOISE=$(psql_cmd -c "
  SELECT COUNT(*) FROM embeddings
  WHERE chroma_collection = 'UNEMBEDDABLE' AND failure_reason = 'noise'
")
HEALED=$(psql_cmd -c "
  SELECT COUNT(*) FROM embeddings
  WHERE chroma_collection = 'convo-messages'
    AND message_id IN (
      SELECT message_id FROM embeddings WHERE chroma_collection = 'UNEMBEDDABLE'
    )
")
echo "  NaN-blocked:  $REMAINING_NAN"
echo "  Noise:        $REMAINING_NOISE"
echo "  Healed (orphans pending cleanup): $HEALED"
