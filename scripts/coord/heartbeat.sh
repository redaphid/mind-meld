#!/usr/bin/env bash
# Record that the coordinator is alive and what it did this cycle.
#
# Deliberately quiet: it edits ONE pinned comment in place rather than posting a
# new one, so cycles do not spam the operator's notifications. The deadman
# workflow watches this comment's timestamp, so a coordinator that goes
# unresponsive is detected without anyone noticing it by hand.
#
#   scripts/coord/heartbeat.sh "reviewed PR #72 round 2, deployed 1.13.0"
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh

NOTE="${1:-cycle complete}"
CHANNEL="$(active_channel)"
[ -n "$CHANNEL" ] || { echo "no active channel (no issue labeled coordinator-active)" >&2; exit 1; }
GEN="$(active_generation "$CHANNEL")"

BODY="$HEARTBEAT_MARKER
$(coord_marker "$GEN") heartbeat — last cycle $(date -u +%Y-%m-%dT%H:%M:%SZ)

$NOTE

<sub>Edited in place each cycle so it never spams notifications. If this timestamp goes stale the deadman workflow will say so out loud.</sub>"

ID="$(heartbeat_id "$CHANNEL" || true)"
if [ -n "$ID" ]; then
  gh api --method PATCH "repos/$GH_REPO/issues/comments/$ID" -f body="$BODY" --silent
  echo "heartbeat updated on #$CHANNEL"
else
  gh issue comment "$CHANNEL" --repo "$GH_REPO" --body "$BODY"
fi

# Staleness is a per-cycle condition, not a permanent mark.
gh issue edit "$CHANNEL" --repo "$GH_REPO" --remove-label coordinator-stale 2>/dev/null || true
