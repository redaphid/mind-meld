#!/usr/bin/env bash
# What has an unanswered comment on it? One GraphQL call, no full bodies.
#
# The coordinator kept missing operator comments because finding them meant
# pulling every issue and PR and reading them — expensive enough that it got
# skipped. This makes "who is waiting on a reply" a one-second question, so the
# coordinator can poke or regenerate the responsible subagent instead of
# discovering the backlog hours later.
#
# Everyone posts under one GitHub account, so authorship is by marker. Which
# markers, and what they mean, is NOT decided here — this script had its own
# copy of that rule and it disagreed with lib.sh's, which is how the coordinator
# channel showed as permanently unanswered (its heartbeat comment starts with an
# HTML comment, not an emoji). One classifier, in comments.mjs, tested.
#
#   scripts/coord/inbox.sh          # threads awaiting a reply
#   scripts/coord/inbox.sh --all    # every open thread, with its last speaker
set -euo pipefail
. "$(dirname "$0")/lib.sh"

ALL=()
[ "${1:-}" = "--all" ] && ALL=(--all)

OWNER="${GH_REPO%%/*}"
NAME="${GH_REPO##*/}"
GEN="$(active_generation 2>/dev/null || true)"

# One request. `comments(last: 1)` means we never transfer whole threads.
gh api graphql -f owner="$OWNER" -f name="$NAME" -f query='
query($owner:String!, $name:String!) {
  repository(owner:$owner, name:$name) {
    issues(states:OPEN, first:100, orderBy:{field:UPDATED_AT, direction:DESC}) {
      nodes { number title updatedAt
        labels(first:20){nodes{name}}
        comments(last:1){nodes{createdAt url body}} }
    }
    pullRequests(states:OPEN, first:50, orderBy:{field:UPDATED_AT, direction:DESC}) {
      nodes { number title updatedAt isDraft headRefName
        labels(first:20){nodes{name}}
        comments(last:1){nodes{createdAt url body}} }
    }
  }
}' | node "$COORD_DIR/comments.mjs" inbox --generation "$GEN" ${ALL[@]+"${ALL[@]}"}
