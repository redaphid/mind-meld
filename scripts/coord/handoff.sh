#!/usr/bin/env bash
# Hand coordination to a fresh generation, in one command.
#
# The whole point: this does NOT require the outgoing coordinator to be healthy.
# The state record is derived from GitHub by state.sh, so a coordinator that is
# slow, wedged, or already dead can be replaced by anyone — the operator, CI, or
# the incoming coordinator itself — without a design conversation.
#
#   scripts/coord/handoff.sh --to v3 --reason "context pressure"
#   scripts/coord/handoff.sh --to v3 --reason "predecessor unresponsive" --force
#
# --force skips the courtesy comment on the old channel, for when the outgoing
# coordinator is presumed dead and nobody is reading it.
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh

TO="" REASON="routine rotation" FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --to) TO="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TO" ] || { echo "usage: handoff.sh --to vN [--reason ...] [--force]" >&2; exit 2; }

OLD="$(active_channel || true)"
OLD_GEN="${OLD:+$(active_generation "$OLD")}"
STATE="$(./state.sh)"

gh label create "coordinator-$TO" --repo "$GH_REPO" --color 0E8A16 \
  --description "Channel for coordinator $TO" 2>/dev/null || true
gh label create coordinator-active --repo "$GH_REPO" --color 5319E7 \
  --description "The one channel that currently owns coordination" 2>/dev/null || true

NEW="$(gh issue create --repo "$GH_REPO" \
  --title "📡 Coordinator $TO channel — orchestrator on branch coordinator/$TO" \
  --label "coordinator-$TO" --label coordinator-active \
  --body "$(cat <<EOF
**Coordinator $TO owns coordination from this issue forward.**${OLD:+ Predecessor: #$OLD (\`$OLD_GEN\`).} Reason for rotation: $REASON.

Talk to me here. My comments start with \`$(coord_marker "$TO")\`; anything in this thread without that marker is the operator. I act only on comments the API verifies as OWNER-authored.

This channel was opened by \`scripts/coord/handoff.sh\`, and the state below was derived from GitHub rather than inherited from my predecessor's context — so nothing was lost if it was already unresponsive. See docs/coordinator-handoff.md.

$STATE
EOF
)")"

NEWNUM="${NEW##*/}"
[ -n "$OLD" ] && gh issue edit "$OLD" --repo "$GH_REPO" --remove-label coordinator-active

if [ -n "$OLD" ] && [ "$FORCE" -eq 0 ]; then
  gh issue comment "$OLD" --repo "$GH_REPO" --body "$(coord_marker "${OLD_GEN:-?}") **handoff.** Coordination moved to #$NEWNUM ($REASON). This channel is historical; the state record travelled with the \`coordinator-active\` label, not with my context. I stop coordinating as of this comment."
fi

echo "coordination: ${OLD:+#$OLD → }#$NEWNUM"
