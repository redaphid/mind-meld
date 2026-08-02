#!/usr/bin/env bash
# What has an unanswered comment on it? One GraphQL call, no full bodies.
#
# The coordinator kept missing operator comments because finding them meant
# pulling every issue and PR and reading them — expensive enough that it got
# skipped. This makes "who is waiting on a reply" a one-second question, so the
# coordinator can poke or regenerate the responsible subagent instead of
# discovering the backlog hours later.
#
# Everyone posts under one GitHub account, so authorship is by marker, and the
# marker is parsed in exactly one place: scripts/coord/marker.mjs. The emoji
# test that used to live in this jq pipeline disagreed with the one in lib.sh,
# and neither could see past the `<!-- coord-heartbeat -->` that opens every
# heartbeat body — so the coordinator's own heartbeat showed up here as a
# thread waiting on a reply. See docs/agent-authorship.md.
#
#   scripts/coord/inbox.sh          # threads awaiting a reply
#   scripts/coord/inbox.sh --all    # every open thread, with its last speaker
set -euo pipefail
. "$(dirname "$0")/lib.sh"

SHOW_ALL=0
[ "${1:-}" = "--all" ] && SHOW_ALL=1

OWNER="${GH_REPO%%/*}"
NAME="${GH_REPO##*/}"

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
}' --jq '
  [ (.data.repository.issues.nodes[] | . + {kind:"issue"}),
    (.data.repository.pullRequests.nodes[] | . + {kind:"PR"}) ]
  | map({
      kind, number, title, updatedAt,
      draft: (.isDraft // false),
      branch: (.headRefName // ""),
      labels: [.labels.nodes[].name],
      last: (.comments.nodes[0] // null)
    })
' \
| node "$(dirname "$0")/marker.mjs" threads-waiting --format \
| while IFS=$'\037' read -r state kind num when labels title preview url; do
  # Unit separator, not tab: tab counts as IFS whitespace, so `read` collapses
  # runs of it and an empty labels field silently shifts every later column.
  [ "$SHOW_ALL" -eq 0 ] && [ "$state" = "ok" ] && continue
  if [ "$state" = "WAITING" ]; then mark="●"; else mark=" "; fi
  printf '%s %-5s #%-4s %s\n' "$mark" "$kind" "$num" "$title"
  printf '        %s  [%s]\n' "$when" "${labels:-no labels}"
  printf '        %s\n' "$preview"
  [ -n "$url" ] && printf '        %s\n' "$url"
  echo
done

echo "● = last word is the operator's; nobody has replied."
[ "$SHOW_ALL" -eq 0 ] && echo "  (--all to include threads already answered)"
