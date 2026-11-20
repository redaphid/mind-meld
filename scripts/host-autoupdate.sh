#!/usr/bin/env bash
# Keeps a host running the newest images published from main, and says so.
#
#   scripts/host-autoupdate.sh run      update if needed, then report and alert
#   scripts/host-autoupdate.sh status   what this host runs and whether it is the latest
#   scripts/host-autoupdate.sh pause    stop updating (use before a manual rollback)
#   scripts/host-autoupdate.sh resume
#
# Meant to run every few minutes from a scheduler, from the checkout compose
# was started from. Settings are AUTOUPDATE_* variables, read from the
# environment or from the checkout's .env (see .env.example).
set -uo pipefail
export MSYS_NO_PATHCONV=1

# `run` fast-forwards the checkout this file lives in. Bash reads a script as it
# executes it, and on Windows git cannot replace a file that is open, so the run
# continues from a private copy.
if [[ -z "${AUTOUPDATE_RUNNING_COPY:-}" ]]; then
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  copy="$(mktemp "${TMPDIR:-/tmp}/host-autoupdate.XXXXXX")"
  cp "${BASH_SOURCE[0]}" "$copy"
  AUTOUPDATE_RUNNING_COPY="$copy" AUTOUPDATE_REPO="${AUTOUPDATE_REPO:-$repo}" exec bash "$copy" "$@"
fi
trap 'rm -f "$AUTOUPDATE_RUNNING_COPY"' EXIT

REPO="$AUTOUPDATE_REPO"
cd "$REPO" || exit 1

env_file_value() { grep -E "^$1=" "$REPO/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r'; }
setting() {
  local value="${!1:-}"
  [[ -n "$value" ]] || value="$(env_file_value "$1")"
  printf '%s' "${value:-$2}"
}

BRANCH="$(setting AUTOUPDATE_BRANCH main)"
IMAGE_MATCH="$(setting AUTOUPDATE_IMAGE_MATCH '*/mindmeld-*')"
# Postgres is the stock server image, rebuilt by every publish with nothing of
# ours in it: following it would restart the database on every merge.
EXCLUDE="$(setting AUTOUPDATE_EXCLUDE_SERVICES postgres)"
STATE_DIR="$(setting AUTOUPDATE_STATE_DIR "$REPO/.autoupdate")"
STALE_AFTER_MIN="$(setting AUTOUPDATE_STALE_AFTER_MINUTES 120)"
REALERT_MIN="$(setting AUTOUPDATE_REALERT_MINUTES 360)"
IDLE_WAIT_SEC="$(setting AUTOUPDATE_IDLE_WAIT_SECONDS 600)"
CPU_IDLE_PCT="$(setting AUTOUPDATE_CPU_IDLE_PCT 5)"
HEALTH_URL="$(setting AUTOUPDATE_HEALTH_URL http://127.0.0.1:3847/health)"
HEALTH_WAIT_SEC="$(setting AUTOUPDATE_HEALTH_WAIT_SECONDS 300)"
NTFY_URL="$(setting AUTOUPDATE_NTFY_URL '')"
NTFY_TOPIC="$(setting AUTOUPDATE_NTFY_TOPIC '')"
NTFY_USER="$(setting AUTOUPDATE_NTFY_USER '')"
NTFY_PASS="$(setting AUTOUPDATE_NTFY_PASS '')"

STATUS_FILE="$STATE_DIR/status.json"
LAST_RUN_FILE="$STATE_DIR/last-run"
FETCHED_FILE="$STATE_DIR/fetched"
UNKNOWN_FILE="$STATE_DIR/unknown-since"
ALERT_FILE="$STATE_DIR/alert"
FAILURE_FILE="$STATE_DIR/failure"
PAUSE_FILE="$STATE_DIR/paused"
LOCK_DIR="$STATE_DIR/lock"
LOG_FILE="$STATE_DIR/autoupdate.log"
mkdir -p "$STATE_DIR"

log() { printf '%s  %s\n' "$(date '+%F %T')" "$*"; }
# Every docker call is bounded, so a wedged engine cannot hold the lock forever.
DOCKER_TIMEOUT=300
dk() { timeout "$DOCKER_TIMEOUT" docker "$@" 2>&1 | tr -d '\r'; }
short() { printf '%s' "${1:0:8}"; }
iso() { date -u -d "@$1" '+%FT%TZ'; }
excluded() { [[ " ${EXCLUDE//,/ } " == *" $1 "* ]]; }

# --- what is running --------------------------------------------------------
# APP_LINES: one line per running app container, service|container|image ref|revision.
# Returns 1 when docker cannot be asked, so a failure is never read as "nothing runs".
load_app_containers() {
  local listing service name ref
  APP_LINES=""; HELD_LINES=""
  listing="$(dk compose ps --format '{{.Service}}|{{.Name}}')" || { UNKNOWN_REASON="docker compose ps failed: ${listing:0:120}"; return 1; }
  while IFS='|' read -r service name; do
    [[ -n "$name" ]] || continue
    # The ref the container was created from: once a pull moves the tag to a
    # newer image, `compose ps` shows the old image as a bare ID.
    ref="$(dk inspect -f '{{.Config.Image}}' "$name")" || { UNKNOWN_REASON="docker inspect $name failed"; return 1; }
    # shellcheck disable=SC2053  # glob match is intentional
    [[ "$ref" == $IMAGE_MATCH ]] || continue
    if excluded "$service"; then
      HELD_LINES+="$service|$name|$ref|$(container_revision "$name")"$'\n'
    else
      APP_LINES+="$service|$name|$ref|$(container_revision "$name")"$'\n'
    fi
  done <<<"$listing"
  [[ -n "$APP_LINES" ]] || { UNKNOWN_REASON="no running app containers match $IMAGE_MATCH"; return 1; }
}

container_revision() { image_revision "$(dk inspect -f '{{.Image}}' "$1")"; }
image_revision() { dk image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1"; }
is_commit() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$1^{commit}" 2>/dev/null; }

# When main first moved past a revision, as an epoch; 0 when it has not.
# First-parent commit times are the times changes landed on main; a merged
# branch's own commits keep the older times they were written at. A revision
# that is not on main at all counts as behind since main's newest commit.
behind_since() {
  local rev="$1" main="$2"
  [[ "$rev" == "$main" ]] && { echo 0; return; }
  if is_commit "$rev" && git merge-base --is-ancestor "$rev" "$main"; then
    git log --first-parent --reverse --format=%ct "$rev..$main" | head -1
  else
    git log -1 --format=%ct "$main"
  fi
}

fetch_main() {
  # Bounded like every docker call: a hung fetch would hold the lock forever.
  if GIT_TERMINAL_PROMPT=0 timeout 120 git fetch -q origin "$BRANCH" 2>/dev/null; then
    date +%s >"$FETCHED_FILE"; return 0
  fi
  local last; last="$(cat "$FETCHED_FILE" 2>/dev/null || echo 0)"
  UNKNOWN_REASON="cannot fetch origin/$BRANCH (last success $( (( last )) && iso "$last" || echo never))"
  return 1
}

# --- updating ---------------------------------------------------------------
fast_forward_checkout() {
  local head; head="$(git rev-parse HEAD)"
  if [[ "$head" == "$(git rev-parse "origin/$BRANCH")" ]]; then
    CHECKOUT_NOTE="current"; return
  fi
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    CHECKOUT_NOTE="not fast-forwarded: tracked files are modified"; return
  fi
  if ! git merge-base --is-ancestor HEAD "origin/$BRANCH"; then
    CHECKOUT_NOTE="not fast-forwarded: HEAD is not on origin/$BRANCH"; return
  fi
  if git merge -q --ff-only "origin/$BRANCH"; then
    CHECKOUT_NOTE="fast-forwarded $(short "$head") -> $(short "$(git rev-parse HEAD)")"
  else
    CHECKOUT_NOTE="fast-forward failed"
  fi
}

cpu_below() {
  local pct
  pct="$(dk stats --no-stream --format '{{.CPUPerc}}' "$1" | head -1 | tr -d '%')"
  awk -v p="${pct:-0}" -v t="$CPU_IDLE_PCT" 'BEGIN { exit !(p + 0 < t + 0) }'
}

# Waits for the containers about to be replaced to be idle, but never longer
# than IDLE_WAIT_SEC. A container stuck busy must not veto its own replacement.
wait_for_idle() {
  local deadline=$(( $(date +%s) + IDLE_WAIT_SEC )) quiet_passes=0 c busy
  while (( $(date +%s) < deadline )); do
    busy=""
    for c in "$@"; do cpu_below "$c" || busy+=" $c"; done
    if [[ -z "$busy" ]]; then
      (( ++quiet_passes >= 2 )) && { log "idle: $*"; return; }
    else
      quiet_passes=0
      log "busy:$busy; waiting"
    fi
    sleep 5
  done
  log "still busy after ${IDLE_WAIT_SEC}s; replacing anyway"
}

wait_healthy() {
  local start deadline c state pending code=""
  start="$(date +%s)"; deadline=$(( start + HEALTH_WAIT_SEC ))
  while (( $(date +%s) < deadline )); do
    pending=""
    for c in "$@"; do
      state="$(dk inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c")"
      [[ "$state" == "running " || "$state" == "running healthy" ]] || pending+=" $c($state)"
    done
    if [[ -z "$pending" ]]; then
      code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$HEALTH_URL")"
      [[ "$code" == 200 ]] && { log "healthy after $(( $(date +%s) - start ))s"; return 0; }
    fi
    sleep 5
  done
  HEALTH_NOTE="unhealthy after ${HEALTH_WAIT_SEC}s:${pending:- $HEALTH_URL answered ${code:-nothing}}"
  return 1
}

update_containers() {
  local -a services=() refs=() changed=() changed_names=()
  local service name ref rev line out
  while IFS='|' read -r service name ref rev; do
    [[ -n "$service" ]] || continue
    services+=("$service"); refs+=("$ref")
  done <<<"$APP_LINES"

  if ! out="$(DOCKER_TIMEOUT=900 dk compose pull -q "${services[@]}")"; then
    RESULT="pull failed: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"; return 1
  fi

  # A publish pushes each image as its own job finishes, so a pull can land in
  # the middle of one. Deploy only a complete set: every app image labelled
  # with the same commit of main, and that commit not older than anything running.
  local -A revs=()
  for ref in "${refs[@]}"; do rev="$(image_revision "$ref")"; revs["${rev:-unlabelled}"]=1; done
  if (( ${#revs[@]} != 1 )); then
    RESULT="waiting: published images are from different commits ($(for r in "${!revs[@]}"; do short "$r"; printf ' '; done))"
    return 0
  fi
  local published="${!revs[*]}"
  if ! is_commit "$published" || ! git merge-base --is-ancestor "$published" "origin/$BRANCH"; then
    RESULT="refusing: published images carry revision '$(short "$published")', which is not a commit on $BRANCH"
    return 1
  fi
  while IFS='|' read -r service name ref rev; do
    [[ -n "$service" && "$rev" != "$published" ]] || continue
    if ! is_commit "$rev"; then continue; fi   # an unlabelled or foreign image is replaced
    if git merge-base --is-ancestor "$published" "$rev"; then
      RESULT="refusing: published $(short "$published") is older than $service's running $(short "$rev")"
      return 1
    fi
  done <<<"$APP_LINES"

  # Compose already knows which containers differ from their image and config;
  # its dry run names them, and an unchanged container is never touched.
  if ! out="$(dk compose --dry-run up -d --no-build --no-deps "${services[@]}")"; then
    RESULT="compose dry run failed: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"; return 1
  fi
  while IFS= read -r line; do
    [[ "$line" =~ Container\ ([^ ]+)\ Recreate[[:space:]]*$ ]] && changed_names+=("${BASH_REMATCH[1]}")
  done <<<"$out"
  (( ${#changed_names[@]} )) || { RESULT="nothing to update"; return 0; }

  while IFS='|' read -r service name ref rev; do
    for line in "${changed_names[@]}"; do
      if [[ "$line" == "$name" ]]; then
        changed+=("$service")
        # Keep the image being replaced reachable for a rollback.
        dk tag "$(dk inspect -f '{{.Image}}' "$name")" "${ref%:*}:prev" >/dev/null
      fi
    done
  done <<<"$APP_LINES"

  log "replacing: ${changed[*]} with $(short "$published")"
  wait_for_idle "${changed_names[@]}"
  if ! out="$(DOCKER_TIMEOUT=900 dk compose up -d --no-build --no-deps "${changed[@]}")"; then
    RESULT="compose up failed: $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"; return 1
  fi
  HEALTH_NOTE=""
  if ! wait_healthy "${changed_names[@]}"; then
    RESULT="updated ${changed[*]} to $(short "$published") but $HEALTH_NOTE"; return 1
  fi
  RESULT="updated ${changed[*]} to $(short "$published")"
}

# --- reporting --------------------------------------------------------------
# Fills MAIN_SHA, RUNNING, HELD, PUBLISHED, BEHIND_SINCE from APP_LINES.
measure() {
  MAIN_SHA="$(git rev-parse "origin/$BRANCH")"
  RUNNING=""; HELD=""; PUBLISHED=""; BEHIND_SINCE=0
  local service name ref rev since
  local -A seen=()
  while IFS='|' read -r service name ref rev; do
    [[ -n "$service" ]] || continue
    RUNNING+="$service=$(short "${rev:-unlabelled}") "
    if [[ -z "${seen[$ref]:-}" ]]; then
      seen[$ref]=1
      PUBLISHED+="$(short "$(image_revision "$ref")") "
    fi
    since="$(behind_since "$rev" "$MAIN_SHA")"
    if (( since > 0 && (BEHIND_SINCE == 0 || since < BEHIND_SINCE) )); then BEHIND_SINCE="$since"; fi
  done <<<"$APP_LINES"
  while IFS='|' read -r service name ref rev; do
    [[ -n "$service" ]] && HELD+="$service=$(short "${rev:-unlabelled}") "
  done <<<"$HELD_LINES"
  PUBLISHED="$(printf '%s\n' $PUBLISHED | sort -u | tr '\n' ' ')"
}

# STATE is current, behind, stale or unknown. Unknown means this run could not
# find out, which must never read as current.
write_status() {
  local now behind_min=0 state=current
  now="$(date +%s)"
  if [[ -n "$UNKNOWN_REASON" ]]; then
    state=unknown
  else
    (( BEHIND_SINCE > 0 )) && { behind_min=$(( (now - BEHIND_SINCE) / 60 )); state=behind; }
    (( BEHIND_SINCE > 0 && behind_min >= STALE_AFTER_MIN )) && state=stale
  fi
  STATE="$state"; BEHIND_MIN="$behind_min"
  cat >"$STATUS_FILE" <<EOF
{
  "checkedAt": "$(iso "$now")",
  "state": "$state",
  "unknownReason": "${UNKNOWN_REASON//\"/\'}",
  "behindMinutes": $behind_min,
  "staleAfterMinutes": $STALE_AFTER_MIN,
  "main": "${MAIN_SHA:-}",
  "published": "${PUBLISHED% }",
  "running": "${RUNNING% }",
  "notAutoUpdated": "${HELD% }",
  "checkout": "$(git rev-parse HEAD)",
  "lastRun": "$(cat "$LAST_RUN_FILE" 2>/dev/null)",
  "paused": $([[ -e "$PAUSE_FILE" ]] && echo true || echo false)
}
EOF
}

notify() {
  local title="$1" body="$2" priority="$3" code
  if [[ -z "$NTFY_URL" || -z "$NTFY_TOPIC" ]]; then
    log "ERROR no AUTOUPDATE_NTFY_URL/TOPIC set; cannot send: $title"; return 1
  fi
  code="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' ${NTFY_USER:+-u "$NTFY_USER:$NTFY_PASS"} \
    -H "Title: $title" -H "Priority: $priority" -H "Tags: package" -d "$body" \
    "$NTFY_URL/$NTFY_TOPIC" 2>/dev/null)"
  # Only a 200 is a delivery: a redirect to a login page also "succeeds".
  [[ "$code" == 200 ]] && { log "ntfy delivered: $title"; return 0; }
  log "ERROR ntfy push failed (http ${code:-none}): $title"
  return 1
}

# Alerts once when the host has been behind main for too long, or unable to tell
# for as long, again every REALERT_MIN while it stays that way, and once when it
# is current again. A failed push is not recorded as sent, so the next run retries.
alert_if_stale() {
  local now last_state last_sent unknown_since title=""
  now="$(date +%s)"
  read -r last_state last_sent 2>/dev/null <"$ALERT_FILE" || { last_state=ok; last_sent=0; }
  if [[ "$STATE" == unknown ]]; then
    [[ -e "$UNKNOWN_FILE" ]] || echo "$now" >"$UNKNOWN_FILE"
    unknown_since="$(cat "$UNKNOWN_FILE")"
    (( now - unknown_since >= STALE_AFTER_MIN * 60 )) && title="mindmeld host: cannot tell what it runs for $(( (now - unknown_since) / 60 ))m"
  else
    rm -f "$UNKNOWN_FILE"
    [[ "$STATE" == stale ]] && title="mindmeld host is ${BEHIND_MIN}m behind $BRANCH"
  fi
  if [[ -n "$title" ]]; then
    if [[ "$last_state" != stale ]] || (( now - last_sent >= REALERT_MIN * 60 )); then
      notify "$title" \
        "${UNKNOWN_REASON:+$UNKNOWN_REASON
}running: $RUNNING
$BRANCH: $(short "${MAIN_SHA:-}")  published: $PUBLISHED
last run: $(cat "$LAST_RUN_FILE" 2>/dev/null)
checkout: ${CHECKOUT_NOTE:-}$([[ -e "$PAUSE_FILE" ]] && printf '\nupdates are PAUSED')" high \
        && echo "stale $now" >"$ALERT_FILE"
    fi
  elif [[ "$last_state" == stale && "$STATE" == current ]]; then
    notify "mindmeld host is current again" "running $(short "$MAIN_SHA") from $BRANCH" default \
      && echo "ok $now" >"$ALERT_FILE"
  fi
}

# A failed update can leave the host on main's revision but broken, which the
# staleness check cannot see. Each distinct failure is sent once per REALERT_MIN.
alert_failure() {
  local now last_sent last_text
  now="$(date +%s)"
  { read -r last_sent; read -r last_text; } 2>/dev/null <"$FAILURE_FILE" || { last_sent=0; last_text=""; }
  if [[ "$RESULT" != "$last_text" ]] || (( now - last_sent >= REALERT_MIN * 60 )); then
    notify "mindmeld host update failed" "$RESULT" high && printf '%s\n%s\n' "$now" "$RESULT" >"$FAILURE_FILE"
  fi
}

print_status() {
  local verdict
  case "$STATE" in
    current) verdict="CURRENT" ;;
    behind)  verdict="BEHIND ${BEHIND_MIN}m (alert after ${STALE_AFTER_MIN}m)" ;;
    stale)   verdict="STALE: ${BEHIND_MIN}m behind (alert threshold ${STALE_AFTER_MIN}m)" ;;
    unknown) verdict="UNKNOWN: $UNKNOWN_REASON" ;;
  esac
  printf 'mindmeld on this host: %s\n' "$verdict"
  printf '  running    %s\n' "${RUNNING:-?}"
  [[ -n "${HELD:-}" ]] && printf '  not auto-updated  %s\n' "$HELD"
  [[ -n "${MAIN_SHA:-}" ]] && printf '  %-10s %s  %s\n' "$BRANCH" "$(short "$MAIN_SHA")" \
    "$(git log -1 --format='%cd %s' --date=format:'%F %R' "$MAIN_SHA" | cut -c1-70)"
  printf '  published  %s (as of the last pull)\n' "${PUBLISHED:-?}"
  printf '  checkout   %s\n' "$(short "$(git rev-parse HEAD)")"
  printf '  last run   %s\n' "$(cat "$LAST_RUN_FILE" 2>/dev/null || echo never)"
  [[ -e "$PAUSE_FILE" ]] && printf '  PAUSED     since %s; undo with: scripts/host-autoupdate.sh resume\n' "$(cat "$PAUSE_FILE")"
  printf '  details    %s\n' "$STATUS_FILE"
}

# Fills everything the reports need; never mistakes a failure for "current".
observe() {
  UNKNOWN_REASON=""; MAIN_SHA=""; RUNNING=""; HELD=""; PUBLISHED=""; BEHIND_SINCE=0
  if ! git rev-parse -q --verify "origin/$BRANCH" >/dev/null; then
    UNKNOWN_REASON="no origin/$BRANCH in the checkout"; return 1
  fi
  load_app_containers && measure
}

# --- commands ---------------------------------------------------------------
# The lock records its owner. It is broken only when that process is gone; every
# docker call is bounded, so a live owner is a run that will finish.
take_lock() {
  local owner
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    owner="$(cat "$LOCK_DIR/pid" 2>/dev/null)"
    if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
      log "run $owner holds the lock; skipping"; exit 0
    fi
    # A run between its mkdir and writing its pid looks ownerless for a moment.
    if [[ -z "$owner" ]] && (( $(date +%s) - $(stat -c %Y "$LOCK_DIR") < 60 )); then
      log "a run is taking the lock; skipping"; exit 0
    fi
    # Two starters can both judge the same lock dead. A rename succeeds for only
    # one of them, so only that one breaks it. What it moved must still be the
    # lock it judged: a run may have broken and retaken it in between.
    local dead="$LOCK_DIR.dead.$$"
    rm -rf "$dead"
    if ! mv -T "$LOCK_DIR" "$dead" 2>/dev/null; then
      log "another run broke the lock first; skipping"; exit 0
    fi
    if [[ "$(cat "$dead/pid" 2>/dev/null)" != "$owner" ]] \
      || { [[ -z "$owner" ]] && (( $(date +%s) - $(stat -c %Y "$dead") < 60 )); }; then
      mv -nT "$dead" "$LOCK_DIR" 2>/dev/null
      log "another run took the lock; skipping"; exit 0
    fi
    rm -rf "$dead"
    log "broke a lock left by run ${owner:-?}, which is gone"
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
      log "another run took the lock; skipping"; exit 0
    fi
  fi
  echo "$$" >"$LOCK_DIR/pid"
  trap '[[ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" == "$$" ]] && rm -rf "$LOCK_DIR"; rm -f "$AUTOUPDATE_RUNNING_COPY"' EXIT
}

cmd_run() {
  take_lock
  CHECKOUT_NOTE=""; RESULT=""; UNKNOWN_REASON=""
  if fetch_main; then
    fast_forward_checkout
    log "checkout: $CHECKOUT_NOTE"
  fi
  if [[ -e "$PAUSE_FILE" ]]; then
    RESULT="paused"
  elif [[ -n "$UNKNOWN_REASON" ]]; then
    RESULT="skipped: $UNKNOWN_REASON"
  elif ! load_app_containers; then
    RESULT="skipped: $UNKNOWN_REASON"
  elif ! update_containers; then
    alert_failure
  fi
  log "result: $RESULT"
  echo "$(date '+%F %T') $RESULT" >"$LAST_RUN_FILE"
  local fetch_problem="$UNKNOWN_REASON"
  observe
  UNKNOWN_REASON="${fetch_problem:-$UNKNOWN_REASON}"
  write_status
  log "state: $STATE${UNKNOWN_REASON:+ ($UNKNOWN_REASON)}, running $RUNNING, $BRANCH $(short "${MAIN_SHA:-}")"
  alert_if_stale
  # Bounded log; this runs every few minutes forever.
  if [[ -f "$LOG_FILE" ]] && (( $(wc -l <"$LOG_FILE") > 4000 )); then
    tail -n 2000 "$LOG_FILE" >"$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
}

cmd_status() {
  UNKNOWN_REASON=""
  local fetch_problem=""
  fetch_main || fetch_problem="$UNKNOWN_REASON"
  observe
  UNKNOWN_REASON="${fetch_problem:-$UNKNOWN_REASON}"
  write_status
  print_status
  [[ "$STATE" == current ]]
}

case "${1:-status}" in
  run)    cmd_run >>"$LOG_FILE" 2>&1 ;;
  status) cmd_status ;;
  pause)  date '+%F %T' >"$PAUSE_FILE"; echo "updates paused; status still reports and alerts" ;;
  resume) rm -f "$PAUSE_FILE"; echo "updates resumed" ;;
  *)      sed -n '2,12p' "$0"; exit 2 ;;
esac
