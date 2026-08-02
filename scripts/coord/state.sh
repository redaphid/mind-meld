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

CHANNEL="$(active_channel || true)"
STATUS_URL="${MINDMELD_STATUS_URL:-http://localhost:3847/status}"

echo "## Coordination state — derived from GitHub at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

echo "### Channel"
if [ -n "$CHANNEL" ]; then
  hb="$(heartbeat_updated_at "$CHANNEL" || true)"
  echo "- Active channel: #$CHANNEL (generation \`$(active_generation "$CHANNEL")\`)"
  echo "- Last heartbeat: ${hb:-none recorded}"
else
  echo "- **No issue carries \`coordinator-active\`. Coordination is unowned.**"
fi
echo

if [ -n "$CHANNEL" ]; then
  echo "### Operator messages awaiting a reply"
  inbox="$(unanswered_operator_comments "$CHANNEL" || true)"
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

echo "### Open PRs"
gh pr list --repo "$GH_REPO" --state open --json number,title,isDraft,headRefName,updatedAt \
  -q '.[] | "- #\(.number) \(if .isDraft then "(draft) " else "" end)\(.title) — `\(.headRefName)`, updated \(.updatedAt)"' \
  || echo "- none"
echo

echo "### Board"
for label in in-progress in-review waiting-on-user needs-human agent-ready; do
  echo "- **$label**: $(gh issue list --repo "$GH_REPO" --label "$label" --state open --json number -q '[.[].number] | map("#\(.)") | join(", ") // ""' || true)"
done
echo

# An unlabeled open issue can only be operator-authored: every agent labels its
# own issues at creation. So this list is the operator's authoritative asks.
echo "### Unlabeled — operator-authored, authoritative"
gh issue list --repo "$GH_REPO" --state open --json number,title,labels \
  -q '.[] | select(.labels | length == 0) | "- #\(.number) \(.title)"' \
  || echo "- none"
