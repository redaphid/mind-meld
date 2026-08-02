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

# OPT-IN, and silent for everyone else.
#
# This is registered in `.claude/settings.json`, which is committed, so it runs
# for every contributor to this public repo — not just the coordinator. Without
# this gate any developer with a large transcript is told, in a session that has
# nothing to do with coordination, to run `handoff.sh --to vNEXT`. Advice that
# arrives in the wrong context is not advice, it is noise, and it teaches people
# to ignore the channel that matters.
#
# The coordinator opts in by exporting COORD_CONTEXT_GUARD=1 in its own
# environment (or in .claude/settings.local.json, which is gitignored). Default
# off: an unset variable means "not the coordinator".
#
# This script lives under scripts/, not .claude/, for the same reason the comms
# hooks do (#77): nothing about measuring a transcript or moving a label is
# specific to one vendor's agent runtime. `.claude/settings.json` is only the
# registration that happens to invoke it.
[ "${COORD_CONTEXT_GUARD:-0}" = "1" ] || exit 0

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
