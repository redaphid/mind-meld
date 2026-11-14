#!/bin/sh
# Restore drill: restore a generation's postgres dump into a throwaway cluster
# and check it against the counts recorded inside the dump's own snapshot.
#
# Usage: restore-test.sh [generation dir]   (default: the newest)
#
# The cluster lives in /tmp inside this container, listens on a unix socket
# only, and is deleted on exit. It never touches the live server except for
# read-only SELECTs that compare live rows up to the dump's highest ids.
# Result: $BACKUP_DIR/restore-test.json. Failure raises an alert.
. "$(dirname "$0")/lib.sh"

gen=${1:-$(newest_generation)}
[ -n "$gen" ] && [ -d "$gen" ] || { alert "restore drill found no generation to restore"; exit 1; }
manifest="$gen/MANIFEST.json"
drill=/tmp/restore-drill
port=5499
started=$(date +%s)
mkdir -p "$STATE"
runlog="$STATE/restore-test.log"
: >"$runlog"

stop_cluster() {
	su-exec postgres pg_ctl -D "$drill/data" -m immediate stop >/dev/null 2>&1 || true
	rm -rf "$drill"
}
trap stop_cluster EXIT
die() {
	alert "restore drill of $(basename "$gen") failed: $1"
	exit 1
}

log "restore drill of $(basename "$gen") starting"
(cd "$gen" && sha256sum -c -s SHA256SUMS) || die "checksums do not match SHA256SUMS"

stop_cluster
mkdir -p "$drill" && chown postgres:postgres "$drill"
su-exec postgres initdb -D "$drill/data" -U postgres -A trust --no-sync >>"$runlog" 2>&1 || die "initdb failed"
su-exec postgres pg_ctl -D "$drill/data" -w -l "$drill/server.log" \
	-o "-c listen_addresses='' -c unix_socket_directories=$drill -p $port -c fsync=off -c full_page_writes=off -c synchronous_commit=off -c max_wal_size=8GB" \
	start >>"$runlog" 2>&1 || die "throwaway cluster would not start"

local_psql() { psql -X -h "$drill" -p "$port" -U postgres "$@"; }
local_psql -d postgres -qc "create database conversations" >>"$runlog" 2>&1 || die "create database failed"
pg_restore -h "$drill" -p "$port" -U postgres -d conversations --no-owner --no-acl --exit-on-error --jobs=4 \
	"$gen/conversations.pgdump" >>"$runlog" 2>&1 || die "pg_restore failed ($(tail -1 "$runlog"))"
restored_at=$(date +%s)

restored=$(local_psql -d conversations -At -F ' ' -c "$COUNT_SQL") || die "counting restored rows failed"
mismatches=
json_counts=
for kv in $(echo "$restored" | tr ' ' '='); do
	k=${kv%%=*}
	v=${kv#*=}
	want=$(manifest_get "$manifest" "pg_$k")
	[ "$v" = "$want" ] || mismatches="$mismatches $k(restored=$v,dumped=$want)"
	json_counts="$json_counts  \"restored_$k\": \"$v\",
"
done

# Live rows up to the dump's highest ids: the part of the live database the dump
# should contain. Rows deleted since the dump make live smaller, never larger.
max_msg=$(manifest_get "$manifest" pg_max_message_id)
max_sess=$(manifest_get "$manifest" pg_max_session_id)
live=$(psql -XAt -F ' ' -c "select 'messages', count(*) from messages where id <= $max_msg
union all select 'sessions', count(*) from sessions where id <= $max_sess
union all select 'memory_messages', count(*) from messages where role = 'memory' and id <= $max_msg
union all select 'messages_now', count(*) from messages
union all select 'sessions_now', count(*) from sessions") || die "live comparison query failed"
json_live=
for kv in $(echo "$live" | tr ' ' '='); do
	json_live="$json_live  \"live_${kv%%=*}\": \"${kv#*=}\",
"
done

finished=$(date +%s)
ok=true
[ -z "$mismatches" ] || ok=false
out="$STAGING/restore-test.json.tmp"
{
	echo "{"
	echo "  \"ok\": $ok,"
	echo "  \"generation\": \"$(basename "$gen")\","
	echo "  \"finished_at\": \"$(date -u -d "@$finished" +%FT%TZ)\","
	echo "  \"restore_seconds\": $((restored_at - started)),"
	echo "  \"duration_seconds\": $((finished - started)),"
	printf '%s' "$json_counts$json_live"
	echo "  \"mismatches\": \"$(echo $mismatches)\""
	echo "}"
} >"$out"
mv "$out" "$BACKUP_DIR/restore-test.json"

[ "$ok" = true ] || die "restored rows differ from the dump's own counts:$mismatches"
log "restore drill of $(basename "$gen") passed in $((finished - started))s (restore $((restored_at - started))s)"
