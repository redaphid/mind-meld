#!/usr/bin/env bash
# Is the coordinator alive, and what is it doing? One command, no waiting.
#
# The operator should never have to infer liveness from whether comments are
# appearing. This answers it directly, in under a second.
#
#   scripts/coord/ping.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"

CHANNEL="$(active_channel || true)"
if [ -z "$CHANNEL" ]; then
  echo "DEAD — no issue carries coordinator-active. Nobody is coordinating."
  echo "  fix: scripts/coord/handoff.sh --to vNEXT --reason 'unowned' --force"
  exit 1
fi

HB="$(heartbeat_updated_at "$CHANNEL" || true)"
GEN="$(active_generation "$CHANNEL")"

if [ -z "$HB" ]; then
  echo "UNKNOWN — channel #$CHANNEL ($GEN) exists but has never recorded a heartbeat."
  exit 1
fi

AGE=$(( ( $(date -u +%s) - $(date -u -d "$HB" +%s) ) / 60 ))
if [ "$AGE" -lt 150 ]; then STATE=ALIVE; else STATE="STALE — rotate it"; fi

echo "$STATE — coordinator $GEN on #$CHANNEL, last heartbeat ${AGE}m ago"
echo
echo "Last cycle said:"
gh api "repos/$GH_REPO/issues/$CHANNEL/comments" --paginate \
  --jq "[.[] | select(.body | contains(\"$HEARTBEAT_MARKER\"))] | last | .body" \
  | sed -n '3,5p'
echo
echo "Work it currently claims to be running:"
gh issue list --repo "$GH_REPO" --label in-progress --state open \
  --json number,title -q '.[] | "  #\(.number) \(.title)"' || true
gh pr list --repo "$GH_REPO" --state open --json number,title,isDraft \
  -q '.[] | "  PR #\(.number) \(if .isDraft then "(draft) " else "" end)\(.title)"' || true
echo
echo "To force a cycle now, without waiting for the hourly run:"
echo "  https://claude.ai/code/routines  →  'Mindmeld coordinator hourly cycle'  →  Run now"
