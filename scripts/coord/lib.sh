#!/usr/bin/env bash
# Shared helpers for the coordinator handoff toolchain.
# Every fact here is derived from GitHub. Nothing depends on a running
# coordinator being healthy enough to answer.
set -euo pipefail

REPO="${GH_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
export GH_REPO="$REPO"

# Where this library lives, so callers can find comments.mjs no matter what
# directory they were invoked from.
COORD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Every `gh ... list` in this toolchain MUST pass a limit. gh defaults to 30 and
# says nothing when it truncates: the board silently showed 8 of 14 operator
# issues, oldest-first, under a heading asserting the list was authoritative.
# Anything that hits this cap is reported LOUDLY rather than quietly cut off.
COORD_LIST_LIMIT="${COORD_LIST_LIMIT:-500}"

# Every open issue carrying `coordinator-active`, one per line. Normally one.
active_channels() {
  gh issue list --repo "$REPO" --label coordinator-active --state open \
    --limit "$COORD_LIST_LIMIT" --json number -q '.[].number'
}

# The single active channel. Two channels is a real, reachable state — handoff.sh
# creates the successor with the label before clearing the predecessor's, so any
# failure in between leaves two — and `.[0]` made it indistinguishable from one.
# Callers that render state should use active_channels() and say so out loud;
# this one warns on stderr and picks the lowest so scripts stay deterministic.
active_channel() {
  local nums count
  nums="$(active_channels)"
  count="$(printf '%s' "$nums" | grep -c . || true)"
  if [ "${count:-0}" -gt 1 ]; then
    echo "⚠️  $count issues carry coordinator-active ($(echo "$nums" | tr '\n' ' ')) — coordination is AMBIGUOUS." >&2
    echo "    Fix: gh issue edit <n> --remove-label coordinator-active on all but one." >&2
  fi
  printf '%s' "$nums" | head -1
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

# `id<TAB>updated_at<TAB>body` of the pinned heartbeat, empty if none yet.
# Slurped and resolved in one pass for the same reason as the inbox: with
# `--paginate --jq` the `| last` ran per page and emitted one line per page.
heartbeat_record() {
  gh api "repos/$REPO/issues/$1/comments" --paginate --slurp \
    | node "$COORD_DIR/comments.mjs" heartbeat
}

heartbeat_id()         { heartbeat_record "$1" | cut -f1; }
heartbeat_updated_at() { heartbeat_record "$1" | cut -f2; }

# The channel's first heartbeat, posted at handoff time. Without it a
# coordinator that dies immediately after rotation is invisible forever: the
# deadman has no timestamp to compare and exits 0 every hour, silently.
post_heartbeat() {
  local issue="$1" gen="$2" note="$3" body id
  body="$HEARTBEAT_MARKER
$(coord_marker "$gen") heartbeat — last cycle $(date -u +%Y-%m-%dT%H:%M:%SZ)

$note

<sub>Edited in place each cycle so it never spams notifications. If this timestamp goes stale the deadman workflow will say so out loud.</sub>"

  id="$(heartbeat_id "$issue" || true)"
  if [ -n "$id" ]; then
    gh api --method PATCH "repos/$GH_REPO/issues/comments/$id" -f body="$body" --silent
  else
    gh issue comment "$issue" --repo "$GH_REPO" --body "$body" >/dev/null
  fi
}

# Only the repo owner counts as the operator. The repo is public; anyone can
# comment. Authorship is checked against the API, never a display name.
owner_login() {
  gh repo view "$REPO" --json owner -q .owner.login
}

# Operator comments on an issue that arrived after the coordinator's last
# reply — i.e. the unanswered inbox. Mechanical: no judgement, no memory.
#
# `--slurp`, not `--jq`: with `--paginate --jq` the filter is evaluated once PER
# PAGE, so past 100 comments the cutoff was re-derived per page and already
# answered messages resurfaced every cycle. Slurping means the classifier sees
# the whole thread exactly once. The classification itself lives in
# comments.mjs, where it is unit tested — see the header there for why.
unanswered_operator_comments() {
  local issue="$1" owner gen
  owner="$(owner_login)"
  gen="$(active_generation "$issue" 2>/dev/null || true)"
  gh api "repos/$REPO/issues/$issue/comments" --paginate --slurp \
    | node "$COORD_DIR/comments.mjs" unanswered --owner "$owner" --generation "$gen"
}
