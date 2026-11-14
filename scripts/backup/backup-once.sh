#!/bin/sh
# One backup generation: postgres dump + chroma snapshot + host config.
#
# Everything is built under $BACKUP_DIR/.staging (ignored by Syncthing), verified
# there, and only then renamed into $BACKUP_DIR/generations/<stamp>. A dump that
# fails verification never reaches the synced set, so it cannot replace the
# last good copy on the far end. Killing a run leaves only staging debris, which
# the next run deletes.
#
# Usage: backup-once.sh [--use-dump FILE]
#   --use-dump verifies FILE in place of a fresh pg_dump. It exists to prove the
#   verifier and the alert path reject bad input; nothing it produces is promoted
#   unless FILE passes every check a real dump must pass.
. "$(dirname "$0")/lib.sh"

use_dump=
[ "${1:-}" = "--use-dump" ] && use_dump=$2

mkdir -p "$STATE" "$GENERATIONS"
exec 9>"$STATE/lock"
flock -n 9 || { log "another backup run holds the lock; not starting a second"; exit 0; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
work="$STAGING/$stamp"
runlog="$STATE/last-run.log"
: >"$runlog"
snapdir=/tmp/chroma-snapshot

cleanup() {
	[ -n "${holder_fd_open:-}" ] && exec 8>&- 2>/dev/null
	rm -rf "$work" "$snapdir"
}
trap cleanup EXIT

die() {
	alert "$1"
	exit 1
}

# A bind mount that resolves to the wrong place is silently writable: this is how
# dumps once landed in a VM-internal directory nobody synced. Refuse to run
# unless the target is the synced folder.
if [ -n "$BACKUP_REQUIRE_MARKER" ] && [ ! -e "$BACKUP_DIR/$BACKUP_REQUIRE_MARKER" ]; then
	die "backup dir has no $BACKUP_REQUIRE_MARKER, so it is not the synced folder (wrong mount?)"
fi

find "$STAGING" -mindepth 1 -maxdepth 1 -name '2*' -exec rm -rf {} + 2>/dev/null || true
mkdir -p "$work"
started=$(date +%s)
log "backup $stamp starting"

prev=$(newest_generation || true)
prev_manifest=${prev:+$prev/MANIFEST.json}
prev_get() { [ -n "$prev_manifest" ] && [ -f "$prev_manifest" ] && manifest_get "$prev_manifest" "$1" || true; }

# --- postgres -----------------------------------------------------------------
server_num=$(psql -XAtc "show server_version_num" 2>>"$runlog") || die "cannot reach postgres at ${PGHOST:-?} ($(tail -1 "$runlog"))"
server_major=$((server_num / 10000))
client_major=$(pg_dump --version | sed -n 's/.* \([0-9][0-9]*\)\..*/\1/p')
# A newer pg_dump writes a dump an older server's tools cannot restore; an older
# one refuses a newer server. Same major or nothing.
[ "$server_major" = "$client_major" ] || die "pg_dump is version $client_major but the server is $server_major"
db=$(psql -XAtc "select current_database()")
[ "$db" = "${PGDATABASE:-conversations}" ] || die "connected to database $db, expected ${PGDATABASE:-conversations}"

counts="$work/counts.txt"
if [ -n "$use_dump" ]; then
	cp "$use_dump" "$work/conversations.pgdump"
	psql -XAt -F ' ' -c "$COUNT_SQL" >"$counts"
else
	# Hold one REPEATABLE READ transaction open, export its snapshot, dump from
	# it, then count rows inside the same snapshot. The counts describe exactly
	# what is in the dump, so a restore can be checked for equality, not "close".
	fifo="$STATE/snapshot.fifo"
	rm -f "$fifo" && mkfifo "$fifo"
	psql -XAtq -F ' ' <"$fifo" >"$work/snapshot.out" 2>>"$runlog" &
	holder=$!
	exec 8>"$fifo"
	holder_fd_open=1
	printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' >&8
	i=0
	until [ -s "$work/snapshot.out" ]; do
		i=$((i + 1))
		[ $i -le 60 ] || die "could not export a postgres snapshot"
		sleep 1
	done
	snapshot=$(head -1 "$work/snapshot.out")
	pg_dump --snapshot="$snapshot" --format=custom --compress=zstd:3 --lock-wait-timeout=120000 \
		--file="$work/conversations.pgdump" 2>>"$runlog" || die "pg_dump failed ($(tail -1 "$runlog"))"
	printf '%s;\nCOMMIT;\n\\q\n' "$COUNT_SQL" >&8
	exec 8>&-
	holder_fd_open=
	wait "$holder" || die "row counts inside the dump snapshot failed"
	tail -n +2 "$work/snapshot.out" >"$counts"
	rm -f "$work/snapshot.out" "$fifo"
fi
pg_done=$(date +%s)

count() { sed -n "s/^$1 //p" "$counts"; }
[ "$(count sessions)" -gt 0 ] && [ "$(count messages)" -gt 0 ] || die "database has no sessions or messages"
ratio_ok "$(count messages)" "$(prev_get pg_messages)" || die "messages fell from $(prev_get pg_messages) to $(count messages)"

reason=$("$(dirname "$0")/verify-pgdump.sh" "$work/conversations.pgdump" "$(prev_get pg_dump_bytes)") || die "$reason"
verify_done=$(date +%s)
log "postgres dump verified: $(file_bytes "$work/conversations.pgdump") bytes, dump $((pg_done - started))s, verify $((verify_done - pg_done))s"

# --- chroma -------------------------------------------------------------------
# chroma.sqlite3 runs in rollback-journal mode. sqlite's online backup copies it
# in small steps and releases the lock between them, so chroma's writers are not
# stalled for the whole copy; the busy timeout waits out a writer holding the lock.
# The HNSW segment files are plain files rewritten when chroma persists an
# index. Their (name, size, mtime) is recorded before and after the copy, and the
# copy is retried if any changed, so the copied index matches the snapshot.
segments_signature() { find "$CHROMA_DATA" -mindepth 2 -type f -exec stat -c '%n %s %Y' {} + | sort | cksum; }

[ -s "$CHROMA_DATA/chroma.sqlite3" ] || die "chroma.sqlite3 is missing under $CHROMA_DATA"
attempt=0
while :; do
	attempt=$((attempt + 1))
	rm -rf "$snapdir" && mkdir -p "$snapdir"
	before=$(segments_signature)
	sqlite3 "file:$CHROMA_DATA/chroma.sqlite3?mode=ro" ".timeout 600000" ".backup $snapdir/chroma.sqlite3" 2>>"$runlog" ||
		die "chroma sqlite backup failed ($(tail -1 "$runlog"))"
	for d in "$CHROMA_DATA"/*/; do
		[ -d "$d" ] && cp -a "$d" "$snapdir/"
	done
	[ "$(segments_signature)" = "$before" ] && break
	[ $attempt -lt 5 ] || die "chroma index files kept changing during the copy"
	log "chroma index files changed during copy $attempt; retrying in 60s"
	sleep 60
done
[ "$(sqlite3 "$snapdir/chroma.sqlite3" "PRAGMA quick_check")" = "ok" ] || die "chroma snapshot failed sqlite quick_check"
chroma_rows=$(sqlite3 "$snapdir/chroma.sqlite3" "select count(*) from embeddings")
[ "$chroma_rows" -gt 0 ] || die "chroma snapshot has no embeddings (empty or wrong volume)"
ratio_ok "$chroma_rows" "$(prev_get chroma_embeddings)" || die "chroma embeddings fell from $(prev_get chroma_embeddings) to $chroma_rows"
tar -C "$snapdir" -cf - . | zstd -q -T0 -3 -o "$work/chroma.tar.zst" 2>>"$runlog" || die "chroma archive failed"
zstd -q -t "$work/chroma.tar.zst" || die "chroma archive failed its integrity test"
rm -rf "$snapdir"
chroma_done=$(date +%s)
log "chroma snapshot verified: $chroma_rows embeddings, $(file_bytes "$work/chroma.tar.zst") bytes, $((chroma_done - verify_done))s"

# --- host config (secrets: only ever written to this private folder) ----------
cfg_files=
for f in $HOST_CONFIG_FILES; do
	if [ -f "$HOST_CONFIG_DIR/$f" ]; then cfg_files="$cfg_files $f"; else log "host config $f not found; skipped"; fi
done
[ -n "$cfg_files" ] || die "no host config files found under $HOST_CONFIG_DIR"
# shellcheck disable=SC2086
tar -C "$HOST_CONFIG_DIR" -czf "$work/host-config.tar.gz" $cfg_files || die "host config archive failed"

# --- manifest, promote, prune -------------------------------------------------
(cd "$work" && sha256sum conversations.pgdump chroma.tar.zst host-config.tar.gz >SHA256SUMS)
finished=$(date +%s)
{
	echo "{"
	echo "  \"stamp\": \"$stamp\","
	echo "  \"finished_at\": \"$(date -u -d "@$finished" +%FT%TZ)\","
	echo "  \"duration_seconds\": $((finished - started)),"
	echo "  \"pg_server_major\": $server_major,"
	echo "  \"pg_dump_bytes\": $(file_bytes "$work/conversations.pgdump"),"
	while read -r k v; do echo "  \"pg_$k\": \"$v\","; done <"$counts"
	echo "  \"chroma_embeddings\": $chroma_rows,"
	echo "  \"chroma_archive_bytes\": $(file_bytes "$work/chroma.tar.zst"),"
	echo "  \"host_config_files\": \"$(echo $cfg_files)\""
	echo "}"
} >"$work/MANIFEST.json"
rm -f "$counts"

# Same filesystem, so this rename is atomic: Syncthing sees a complete generation or none.
mv "$work" "$GENERATIONS/$stamp"
cp "$GENERATIONS/$stamp/MANIFEST.json" "$STAGING/latest.json.tmp" && mv "$STAGING/latest.json.tmp" "$BACKUP_DIR/latest.json"

ls -1d "$GENERATIONS"/2* | sort -r | tail -n +$((BACKUP_KEEP + 1)) | while read -r old; do
	rm -rf "$old" && log "pruned $(basename "$old")"
done

log "backup $stamp complete in $((finished - started))s"
clear_alerts
