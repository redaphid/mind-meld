#!/bin/sh
# The sidecar's main process. Runs backup-once.sh daily at BACKUP_AT_UTC and the
# restore drill every RESTORE_TEST_EVERY_DAYS. Every path through the loop ends
# in a sleep, so a run that fails cannot turn into a hot loop.
. "$(dirname "$0")/lib.sh"

BACKUP_AT_UTC=${BACKUP_AT_UTC:-03:17}
RETRY_HOURS=${BACKUP_RETRY_HOURS:-3}
RESTORE_TEST_EVERY_DAYS=${RESTORE_TEST_EVERY_DAYS:-7}
STARTUP_DELAY_SECONDS=${BACKUP_STARTUP_DELAY_SECONDS:-600}
here=$(dirname "$0")

age_seconds() { [ -f "$1" ] && echo $(($(date +%s) - $(stat -c %Y "$1"))) || echo 999999999; }

seconds_until_slot() {
	now=$(date +%s)
	slot=$(date -u -d "$(date -u +%F) $BACKUP_AT_UTC" +%s)
	[ "$slot" -gt "$now" ] || slot=$((slot + 86400))
	echo $((slot - now))
}

attempt() {
	if "$here/backup-once.sh"; then
		if [ "$(age_seconds "$BACKUP_DIR/restore-test.json")" -ge $((RESTORE_TEST_EVERY_DAYS * 86400)) ]; then
			"$here/restore-test.sh" || true
		fi
		return 0
	fi
	return 1
}

log "backup sidecar up: daily at $BACKUP_AT_UTC UTC, keep $BACKUP_KEEP, restore drill every ${RESTORE_TEST_EVERY_DAYS}d"
sleep "$STARTUP_DELAY_SECONDS"

# Catch up after downtime: the box may have been off at the slot.
next=0
if [ "$(age_seconds "$BACKUP_DIR/latest.json")" -ge 86400 ]; then
	attempt || next=$((RETRY_HOURS * 3600))
fi

while :; do
	[ "$next" -gt 0 ] || next=$(seconds_until_slot)
	log "next backup in ${next}s"
	sleep "$next"
	next=0
	# A catch-up run a few hours before the slot already covers today.
	if [ "$(age_seconds "$BACKUP_DIR/latest.json")" -ge 21600 ]; then
		attempt || next=$((RETRY_HOURS * 3600))
	fi
done
