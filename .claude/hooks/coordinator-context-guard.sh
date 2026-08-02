#!/usr/bin/env bash
# Rotate on context pressure BEFORE quality degrades.
#
# A coordinator does not notice its own decline — it just gets slower and
# vaguer, which is exactly how the v1 → v2 handoff became a manual rescue. The
# transcript file is a decent proxy for context consumed, and unlike the model's
# self-assessment it is a number.
#
# Fail-open by contract: any error here exits 0 and says nothing. A guard that
# can brick a coordinator session is worse than no guard.
set -uo pipefail

WARN_BYTES="${COORD_WARN_BYTES:-3500000}"
ROTATE_BYTES="${COORD_ROTATE_BYTES:-5500000}"

# Parsed with sed rather than jq so the guard has no dependency beyond a shell.
input="$(cat 2>/dev/null || true)"
transcript="$(printf '%s' "$input" \
  | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
transcript="${transcript//\\\\/\\}"
[ -n "$transcript" ] && [ -f "$transcript" ] || exit 0

size="$(wc -c < "$transcript" 2>/dev/null || echo 0)"
[ "$size" -ge "$WARN_BYTES" ] 2>/dev/null || exit 0

if [ "$size" -ge "$ROTATE_BYTES" ]; then
  msg="CONTEXT PRESSURE: this coordinator session's transcript is $((size / 1000000))MB. Hand off NOW, before you start dropping detail: run scripts/coord/handoff.sh --to vNEXT --reason 'context pressure'. It derives the state record from GitHub, so handing off costs you nothing and losing coherence costs the operator hours."
else
  msg="Context notice: transcript is $((size / 1000000))MB, approaching the rotation threshold ($((ROTATE_BYTES / 1000000))MB). Externalize state to the channel as you go, and plan to run scripts/coord/handoff.sh soon."
fi

# Messages above contain no double quotes or backslashes, so this is safe to
# emit directly and keeps the guard dependency-free.
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$msg"
exit 0
