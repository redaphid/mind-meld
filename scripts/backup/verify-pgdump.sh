#!/bin/sh
# Usage: verify-pgdump.sh <dump> [previous dump bytes]
# Prints nothing and exits 0 for a usable dump. Otherwise prints one line, the
# reason, and exits 1. The caller decides whether to alert.
. "$(dirname "$0")/lib.sh"

dump=$1
prev=${2:-}
fail() { echo "$1"; exit 1; }

[ -s "$dump" ] || fail "postgres dump is missing or empty"
bytes=$(file_bytes "$dump")
[ "$bytes" -ge "$BACKUP_MIN_BYTES" ] || fail "postgres dump is $bytes bytes, below the $BACKUP_MIN_BYTES-byte minimum"
ratio_ok "$bytes" "$prev" || fail "postgres dump is $bytes bytes, under ${BACKUP_MIN_RATIO_PCT}% of the previous $prev"

toc=$(mktemp)
trap 'rm -f "$toc"' EXIT
pg_restore --list "$dump" >"$toc" 2>/dev/null || fail "pg_restore cannot read the dump's table of contents"
for t in $REQUIRED_TABLES; do
	grep -q "TABLE DATA public $t " "$toc" || fail "postgres dump has no data for table $t (empty or wrong database)"
done

# --list reads only the table of contents at the head of the file, so a dump cut
# short still lists cleanly. Reading every data block is what catches truncation.
pg_restore --file=/dev/null "$dump" 2>/dev/null || fail "pg_restore could not read the whole dump (truncated or corrupt)"
