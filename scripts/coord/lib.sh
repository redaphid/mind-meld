#!/usr/bin/env bash
# Shared helpers for the coordinator handoff toolchain.
# Every fact here is derived from GitHub. Nothing depends on a running
# coordinator being healthy enough to answer.
set -euo pipefail

REPO="${GH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
export GH_REPO="$REPO"

# The single active channel is the one open issue carrying `coordinator-active`.
active_channel() {
  gh issue list --repo "$REPO" --label coordinator-active --state open \
    --json number -q '.[0].number'
}

# Marker that identifies the coordinator's own comments, by generation.
coord_marker() { printf '🤖 **Coordinator %s:**' "$1"; }

# Generation of the active channel, read from its `coordinator-vN` label.
active_generation() {
  local n="${1:-$(active_channel)}"
  gh issue view "$n" --repo "$REPO" --json labels \
    -q '.labels[].name | select(startswith("coordinator-v"))' | head -1 | sed 's/coordinator-//'
}

HEARTBEAT_MARKER='<!-- coord-heartbeat -->'

# Id of the heartbeat comment on an issue, empty if none exists yet.
heartbeat_id() {
  gh api "repos/$REPO/issues/$1/comments" --paginate \
    --jq "[.[] | select(.body | contains(\"$HEARTBEAT_MARKER\"))] | last | .id // empty"
}

heartbeat_updated_at() {
  gh api "repos/$REPO/issues/$1/comments" --paginate \
    --jq "[.[] | select(.body | contains(\"$HEARTBEAT_MARKER\"))] | last | .updated_at // empty"
}

# Only the repo owner counts as the operator. The repo is public; anyone can
# comment. Authorship is checked against the API, never a display name.
owner_login() {
  gh repo view "$REPO" --json owner -q .owner.login
}

# Operator comments on an issue that arrived after the coordinator's last
# reply — i.e. the unanswered inbox. Mechanical: no judgement, no memory.
#
# Authorship is decided by marker.mjs, the one definition every tool shares.
# This used to be a jq filter treating ANY body starting with 🤖 as the
# coordinator having replied, which let a subagent's progress comment BURY a
# question the operator was still waiting on — and it could not see past the
# `<!-- coord-heartbeat -->` that opens every heartbeat, so the coordinator's
# own heartbeat came back as an unanswered operator message. Only a
# `🤖 **Coordinator vN:**` marker closes the loop now.
unanswered_operator_comments() {
  local issue="$1" owner
  owner="$(owner_login)"
  gh api "repos/$REPO/issues/$issue/comments" --paginate --jq '.[]' \
    | node "$(dirname "${BASH_SOURCE[0]}")/marker.mjs" unanswered --owner "$owner"
}
