#!/bin/sh
# Shared configuration and helpers for the backup sidecar (docker-compose.backup.yml).
set -eu
# busybox ash supports pipefail; a failed tar must not hide behind a working zstd.
set -o pipefail
export TZ=UTC

BACKUP_DIR=${BACKUP_DIR:-/backup}
STAGING="$BACKUP_DIR/.staging"
STATE="$STAGING/.state"
GENERATIONS="$BACKUP_DIR/generations"
CHROMA_DATA=${CHROMA_DATA:-/data}
HOST_CONFIG_DIR=${HOST_CONFIG_DIR:-/host-config}
HOST_CONFIG_FILES=${BACKUP_HOST_CONFIG_FILES:-.env docker-compose.override.yml}
BACKUP_KEEP=${BACKUP_KEEP:-2}
BACKUP_MIN_RATIO_PCT=${BACKUP_MIN_RATIO_PCT:-50}
BACKUP_MIN_BYTES=${BACKUP_MIN_BYTES:-1048576}
BACKUP_REQUIRE_MARKER=${BACKUP_REQUIRE_MARKER-.stfolder}
ALERT_REPEAT_HOURS=${BACKUP_ALERT_REPEAT_HOURS:-24}
REQUIRED_TABLES="sessions messages session_chunks embeddings tags projects"

# One query, used both at dump time (inside the dump's snapshot) and after a
# restore, so the two sides are compared with the same definition.
COUNT_SQL="select 'sessions', count(*)::text from sessions
union all select 'messages', count(*)::text from messages
union all select 'session_chunks', count(*)::text from session_chunks
union all select 'embeddings', count(*)::text from embeddings
union all select 'tags', count(*)::text from tags
union all select 'projects', count(*)::text from projects
union all select 'memory_messages', count(*)::text from messages where role = 'memory'
union all select 'max_message_id', coalesce(max(id), 0)::text from messages
union all select 'max_session_id', coalesce(max(id), 0)::text from sessions
union all select 'memory_md5', md5(coalesce(string_agg(external_id || ':' || md5(coalesce(content_text, '')), ',' order by id), '')) from messages where role = 'memory'
union all select 'sessions_md5', md5(coalesce(string_agg(id || ':' || external_id, ',' order by id), '')) from sessions"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# One lock for everything that reads or writes generations, so a drill can never
# restore a generation that a backup run is pruning, and two drills never share
# the throwaway cluster. Busy is exit 75 (EX_TEMPFAIL): the loop retries later.
take_lock() {
	mkdir -p "$STATE"
	exec 9>"$STATE/lock"
	flock -n 9 || { log "another backup or drill holds the lock; not starting"; exit 75; }
}

# log-alerter tails `docker logs`, which is PID 1's stdout. A run started with
# `docker exec` writes somewhere else, so its alerts are copied to PID 1 too.
emit() {
	printf '%s\n' "$1"
	if [ "$(readlink /proc/self/fd/1 2>/dev/null)" != "$(readlink /proc/1/fd/1 2>/dev/null)" ] && [ -w /proc/1/fd/1 ]; then
		printf '%s\n' "$1" >>/proc/1/fd/1
	fi
}

# Optional direct push to ntfy. A log line alone is not enough: a log tailer can
# lose its stream to a container that prints once a day, and then the one line
# that mattered is never read.
#
# Only HTTP 200 counts: `curl -f` passes a 3xx, such as an auth proxy's login redirect.
push() {
	[ -n "${NTFY_URL:-}" ] && [ -n "${NTFY_TOPIC:-}" ] || return 0
	code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' ${NTFY_USER:+-u "$NTFY_USER:$NTFY_PASS"} \
		-H "Title: mindmeld-backup" -H "Priority: high" -H "Tags: floppy_disk,warning" \
		-d "$1" "$NTFY_URL/$NTFY_TOPIC" 2>/dev/null) || true
	[ "$code" = 200 ] || emit "mindmeld-backup: ntfy push failed (http ${code:-none}); the log line above is the only alert"
}

# The line starts with "ERROR:" so log-alerter can push it too. The same failure
# is pushed once per ALERT_REPEAT_HOURS, not once per retry: a stuck fault must not
# flood the phone, and the repeat lines carry no error text for the alerter to match.
alert() {
	record_run FAIL "$1"
	msg="ERROR: mindmeld-backup: $1"
	mkdir -p "$STATE"
	# Keyed without digits: "messages fell from 812 to 3" is the same fault on
	# every retry even when the numbers move.
	f="$STATE/alert-$(printf '%s' "$msg" | tr -d '0-9' | cksum | cut -d' ' -f1)"
	now=$(date +%s)
	last=$(cat "$f" 2>/dev/null || echo 0)
	if [ $((now - last)) -ge $((ALERT_REPEAT_HOURS * 3600)) ]; then
		echo "$now" >"$f"
		emit "$msg"
		push "$1"
	else
		emit "mindmeld-backup: same failure as the alert sent at $(date -u -d "@$last" +%FT%TZ); not re-sent"
	fi
}

# One line per finished run, kept beside the generations. Only BACKUP_KEEP
# generations survive and container logs go with the container, so this is the
# record that answers "how many nights in a row did it work?".
record_run() { printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$1" "$2" >>"$BACKUP_DIR/history.tsv" 2>/dev/null || true; }

clear_alerts() {
	if ls "$STATE"/alert-* >/dev/null 2>&1; then
		rm -f "$STATE"/alert-*
		emit "mindmeld-backup: recovered"
	fi
}

# Manifests are written one key per line so plain sed can read them back.
manifest_get() { sed -n "s/^ *\"$2\": *\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}$/\1/p" "$1" | head -1; }

newest_generation() { ls -1d "$GENERATIONS"/2* 2>/dev/null | sort | tail -1 || true; }

file_bytes() { stat -c %s "$1"; }

# Fails when $1 is below BACKUP_MIN_RATIO_PCT percent of $2. Data here only grows,
# so a large drop means the dump or snapshot came from the wrong or an empty source.
ratio_ok() { [ -z "${2:-}" ] || [ "$2" -eq 0 ] || [ $(($1 * 100)) -ge $(($2 * BACKUP_MIN_RATIO_PCT)) ]; }

# Prints one line per collection whose copied HNSW index replay cannot complete;
# nothing when the copy is whole. The reasoning is in chroma-gaps.py.
hnsw_gaps() { python3 -I "$(dirname "$0")/chroma-gaps.py" "$1"; }
