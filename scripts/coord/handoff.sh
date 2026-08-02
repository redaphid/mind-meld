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
#   scripts/coord/handoff.sh --to v3 --dry-run
#
# --force   skips the courtesy comment on the old channel, for when the outgoing
#           coordinator is presumed dead and nobody is reading it.
# --dry-run performs every read, renders the exact issue body, and prints each
#           mutation it would make without making any of them. This exists
#           because the first version of this script died on its first mutating
#           step and stayed that way: the one-command rotation that is the whole
#           thesis had never once been executed. A rotation path you cannot
#           rehearse is a rotation path you do not have.
set -euo pipefail
cd "$(dirname "$0")"
. ./lib.sh

TO="" REASON="routine rotation" FORCE=0 DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --to) TO="$2"; shift 2 ;;
    --reason) REASON="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TO" ] || { echo "usage: handoff.sh --to vN [--reason ...] [--force] [--dry-run]" >&2; exit 2; }

# Every mutation goes through this, so --dry-run cannot miss one by omission.
mutate() {
  if [ "$DRY" -eq 1 ]; then
    printf 'DRY-RUN would run: %s\n' "$*" >&2
    return 0
  fi
  "$@"
}

OLD="$(active_channel || true)"
OLD_GEN="${OLD:+$(active_generation "$OLD")}"
STATE="$(./state.sh)"

BODY="**Coordinator $TO owns coordination from this issue forward.**${OLD:+ Predecessor: #$OLD (\`$OLD_GEN\`).} Reason for rotation: $REASON.

Talk to me here. My comments start with \`$(coord_marker "$TO")\`; anything in this thread without that marker is the operator. I act only on comments the API verifies as OWNER-authored.

This channel was opened by \`scripts/coord/handoff.sh\`, and the state below was derived from GitHub rather than inherited from my predecessor's context — so nothing was lost if it was already unresponsive. See docs/coordinator-handoff.md.

$STATE"

mutate gh label create "coordinator-$TO" --repo "$GH_REPO" --color 0E8A16 \
  --description "Channel for coordinator $TO" 2>/dev/null || true
mutate gh label create coordinator-active --repo "$GH_REPO" --color 5319E7 \
  --description "The one channel that currently owns coordination" 2>/dev/null || true

if [ "$DRY" -eq 1 ]; then
  echo "DRY-RUN would create issue: 📡 Coordinator $TO channel — orchestrator on branch coordinator/$TO" >&2
  echo "----- body it would post -----" >&2
  printf '%s\n' "$BODY" >&2
  echo "------------------------------" >&2
  NEWNUM="DRYRUN"
else
  # No -q here. `gh issue create` has no such flag — it is `gh api`'s — and
  # under `set -e` it killed the script before it created anything. The command
  # already prints the new issue's URL on stdout, which is all we need.
  NEW="$(gh issue create --repo "$GH_REPO" \
    --title "📡 Coordinator $TO channel — orchestrator on branch coordinator/$TO" \
    --label "coordinator-$TO" --label coordinator-active \
    --body "$BODY")"
  NEWNUM="${NEW##*/}"
fi

# From here until the predecessor's label is cleared, TWO issues carry
# `coordinator-active`. If this step fails that state persists, so say exactly
# how to repair it rather than dying with a bare `set -e` trace.
if [ -n "$OLD" ]; then
  mutate gh issue edit "$OLD" --repo "$GH_REPO" --remove-label coordinator-active || {
    echo "🚨 HANDOFF INCOMPLETE: #$NEWNUM was created but #$OLD still carries coordinator-active." >&2
    echo "   TWO channels are active and both coordinators may believe they own coordination." >&2
    echo "   Repair: gh issue edit $OLD --repo $GH_REPO --remove-label coordinator-active" >&2
    exit 1
  }
fi

# Seed the first heartbeat. Without it the deadman has no timestamp to compare,
# so it exits 0 every hour and a successor that boots and immediately wedges is
# invisible FOREVER — the failure mode this whole toolchain exists to prevent.
mutate post_heartbeat "$NEWNUM" "$TO" "Channel opened by handoff.sh ($REASON). Coordinator $TO has not yet reported a cycle — if this note is still here hours from now, $TO never started."

# A completed rotation resolves any "coordination is unowned" alarm the deadman
# raised, so the alarm cannot accumulate into background noise.
if [ "$DRY" -eq 0 ]; then
  for unowned in $(gh issue list --repo "$GH_REPO" --label coordinator-unowned --state open \
    --limit "$COORD_LIST_LIMIT" --json number -q '.[].number'); do
    gh issue close "$unowned" --repo "$GH_REPO" \
      --comment "Resolved: coordination is owned again by #$NEWNUM (coordinator $TO)." || true
  done
fi

if [ -n "$OLD" ] && [ "$FORCE" -eq 0 ]; then
  mutate gh issue comment "$OLD" --repo "$GH_REPO" --body "$(coord_marker "${OLD_GEN:-?}") **handoff.** Coordination moved to #$NEWNUM ($REASON). This channel is historical; the state record travelled with the \`coordinator-active\` label, not with my context. I stop coordinating as of this comment."
fi

echo "coordination: ${OLD:+#$OLD → }#$NEWNUM"
[ "$DRY" -eq 1 ] && echo "(dry run — nothing was changed)"
exit 0
