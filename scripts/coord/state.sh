#!/usr/bin/env bash
# Derive the whole coordination state from GitHub + the live service.
#
# This is the bootstrap path: a brand new coordinator runs this and is current
# in one page, without reading a single transcript or asking its predecessor
# anything. Handoff cost is therefore independent of how much context the
# outgoing coordinator burned.
#
#   scripts/coord/state.sh            # markdown, for a channel comment
set -euo pipefail
. "$(dirname "$0")/lib.sh"
cd "$(git rev-parse --show-toplevel)"   # package.json lives at the repo root

# Said instead of a section's contents when its fetch did not succeed. Every
# section below is read as fact, so "I could not find out" must never be
# rendered the same way as "there is nothing here".
fetch_failed() {
  echo "- 🚨 **FETCH FAILED — $1 is UNKNOWN, not empty.** The GitHub query did not succeed. Do not treat this section as authoritative."
}

CHANNELS="$(active_channels || true)"
CHANNEL_COUNT="$(printf '%s' "$CHANNELS" | grep -c . || true)"
CHANNEL="$(printf '%s' "$CHANNELS" | head -1)"
STATUS_URL="${MINDMELD_STATUS_URL:-http://localhost:3847/status}"

echo "## Coordination state — derived from GitHub at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

echo "### Channel"
if [ "${CHANNEL_COUNT:-0}" -gt 1 ]; then
  # Reachable, not theoretical: handoff.sh creates the successor carrying
  # `coordinator-active` and only then clears the predecessor's, so any failure
  # in between leaves two. `.[0]` reported the winner as fact.
  echo "- 🚨 **$CHANNEL_COUNT issues carry \`coordinator-active\`: $(echo "$CHANNELS" | sed 's/^/#/' | tr '\n' ' '). Coordination is AMBIGUOUS** — two coordinators may both believe they own it. Clear the label from all but one before doing anything else."
fi
if [ -n "$CHANNEL" ]; then
  hb="$(heartbeat_updated_at "$CHANNEL" || true)"
  echo "- Active channel: #$CHANNEL (generation \`$(active_generation "$CHANNEL")\`)"
  echo "- Last heartbeat: ${hb:-⚠️ none recorded — this channel has never reported liveness}"
else
  echo "- **No issue carries \`coordinator-active\`. Coordination is unowned.**"
fi
echo

if [ -n "$CHANNEL" ]; then
  echo "### Operator messages awaiting a reply"
  # `|| true` here used to turn a failed fetch into "- none", i.e. into "the
  # operator is not waiting on you". Of everything this script prints, that is
  # the one line whose false negative costs the most.
  inbox="$(unanswered_operator_comments "$CHANNEL")" \
    || inbox="$(fetch_failed "the operator inbox")"
  echo "${inbox:-- none}"
  echo
fi

echo "### Release"
# Parsed with node, not jq: the host runs this from git-bash where jq is absent
# but node is a hard dependency of the project anyway.
deployed="$(curl -fsS -m 15 "$STATUS_URL" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("unreachable")}})' \
  2>/dev/null || echo unreachable)"
declared="$(node -p 'require("./package.json").version' 2>/dev/null || echo unknown)"
echo "- Deployed: \`$deployed\` · package.json on this branch: \`$declared\`"
[ "$deployed" != "$declared" ] && echo "- ⚠️ deployed and declared versions differ — a release may be mid-flight or undeployed"
echo

# Every list below passes an explicit --limit and is rendered by render.mjs,
# which SHOUTS if the result reached the cap. gh's silent default of 30 is what
# made this whole section quietly wrong.
#
# Each one is also captured into a variable BEFORE being printed. A pipeline
# inside `echo "$(...)"` cannot fail the script: command substitution's exit
# status is discarded by the enclosing echo, so `set -e` never fires and a
# failed fetch printed as an empty bucket. Assigning first makes the failure
# the assignment's own exit status, which `|| ` can then catch and report.
echo "### Open PRs"
prs="$(gh pr list --repo "$GH_REPO" --state open --limit "$COORD_LIST_LIMIT" \
  --json number,title,isDraft,headRefName,updatedAt \
  | node "$COORD_DIR/render.mjs" prs --limit "$COORD_LIST_LIMIT")" \
  || prs="$(fetch_failed "the open PR list")"
echo "$prs"
echo

echo "### Board"
for label in in-progress in-review waiting-on-user needs-human agent-ready; do
  nums="$(gh issue list --repo "$GH_REPO" --label "$label" --state open \
    --limit "$COORD_LIST_LIMIT" --json number \
    | node "$COORD_DIR/render.mjs" numbers --limit "$COORD_LIST_LIMIT")" \
    || nums="🚨 FETCH FAILED — unknown, not empty"
  echo "- **$label**: $nums"
done
echo

# An unlabeled open issue can only be operator-authored: every agent labels its
# own issues at creation. So this list is the operator's authoritative asks —
# which is exactly why truncating it silently was the worst of the three.
echo "### Unlabeled — operator-authored, authoritative"
unlabeled="$(gh issue list --repo "$GH_REPO" --state open --limit "$COORD_LIST_LIMIT" \
  --json number,title,labels \
  | node "$COORD_DIR/render.mjs" unlabeled --limit "$COORD_LIST_LIMIT")" \
  || unlabeled="$(fetch_failed "the operator's unlabeled issues")"
echo "$unlabeled"
