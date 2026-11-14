# Backups

`docker-compose.backup.yml` runs one sidecar, `mindmeld-backup`, that writes a
verified backup **generation** once a day into a directory you sync off the
machine. Postgres is the source of truth; Chroma is backed up too because
rebuilding it is expensive (see below).

```bash
# .env
MINDMELD_BACKUP_DIR=/path/to/synced/mindmeld-backup   # must contain .stfolder (or set BACKUP_REQUIRE_MARKER)
MINDMELD_HOST_CONFIG_DIR=/path/to/this/checkout        # default: the directory you run compose from

docker compose -p mindmeld-db-backup -f docker-compose.backup.yml up -d --build
```

Always pass `-p mindmeld-db-backup`. `COMPOSE_PROJECT_NAME` in `.env` outranks
the file's `name:`, and without `-p` the sidecar joins the main project, where a
`--remove-orphans` from either compose file deletes the other's containers.

Starting it never touches the database containers: it is its own project, it
reaches Postgres by container name over `mindmeld-network`, and it mounts
Chroma's volume read-only from the running `mindmeld-chroma` container.

## What a generation holds

```
generations/<UTC stamp>/
  conversations.pgdump   pg_dump custom format, zstd
  chroma.tar.zst         chroma.sqlite3 snapshot + HNSW segment directories
  host-config.tar.gz     .env, docker-compose.override.yml (SECRETS)
  MANIFEST.json          sizes, server version, row counts inside the dump's snapshot
  SHA256SUMS
latest.json              copy of the newest MANIFEST.json
restore-test.json        result of the last restore drill
.staging/                work area, excluded from sync (.stignore: /.staging)
```

`host-config.tar.gz` contains credentials, and nothing in a generation is
encrypted: the dump, the Chroma archive and the config archive are plain files.
Syncthing encrypts them in transit only. The backup directory must only ever
sync to machines you would give those credentials to, unless the far end is
added as an untrusted (encrypted) Syncthing device.

Two generations are kept (`BACKUP_KEEP`). History is the far end's job, for
example ZFS snapshots of the receiving dataset; the sidecar keeps a short tail.

## How a bad backup is kept out

The failure this replaces dumped an empty database every night for months, and
nothing noticed. So each run refuses to promote anything it has not checked:

- **Right target.** The backup directory must contain `.stfolder`. A bind mount
  that resolves to the wrong place is silently writable.
- **Right server.** `pg_dump`'s major version must equal the server's. The image
  is built `FROM` the database image so they match.
- **Right database, not empty.** `current_database()` is checked, and the dump
  must hold table data for `sessions`, `messages`, `session_chunks`,
  `embeddings`, `tags` and `projects`, with non-zero sessions and messages.
  A table-of-contents entry exists for an empty table too, so the verifier also
  reads the dump's `sessions` rows and requires at least one.
- **Complete.** `pg_restore --list` reads only the table of contents, which a
  truncated file still has, so the verifier also reads every data block
  (`pg_restore --file=/dev/null`).
- **Not a sudden shrink.** Dump size, message count and Chroma's embedding count
  must each be at least 50% of the previous generation (`BACKUP_MIN_RATIO_PCT`).
- **Chroma consistent.** `chroma.sqlite3` is copied with sqlite's online backup
  (busy timeout, read-only), then `PRAGMA quick_check`. The HNSW files are plain
  files, so their size and nanosecond mtime are recorded before and after the
  copy and the copy is retried if any changed.
- **Chroma replayable.** Chroma records each index's replay point
  (`max_seq_id`) in sqlite and keeps the index in files; on start it replays the
  queue past that point. A copy whose sqlite point is ahead of its index files
  restores with correct counts and vectors that search can never find. So the
  index's element count (hnswlib header) plus the queue left to replay must
  cover every metadata row, or the copy is retried.

Everything is built in `.staging/`, then renamed into `generations/` in one
step. A run killed halfway leaves only staging debris, which the next run
deletes. Backup runs and restore drills share one lock: a second one exits 75
and the loop retries later. Pruning runs only after a promotion and keeps the
`BACKUP_KEEP` newest (at least 1), so the generation just verified is never
pruned.

## Restore drill

`restore-test.sh` restores a generation into a throwaway cluster inside the
sidecar (same image, unix socket only, deleted afterwards) and requires every
count and checksum to equal what `MANIFEST.json` recorded inside the dump's own
snapshot: row counts, the highest ids, an md5 over every memory version, and an
md5 over every session id. It also counts live rows up to the dump's highest
ids, read-only, for comparison. It runs after the first backup of each week
(`RESTORE_TEST_EVERY_DAYS`) and on demand:

```bash
docker exec mindmeld-backup /opt/mindmeld-backup/restore-test.sh
```

## Alerts

Any failure prints `ERROR: mindmeld-backup: <reason>`, including a run that
dies somewhere no check anticipated (disk full while writing the manifest), and, when `BACKUP_NTFY_*`
are set in `.env`, pushes the same text to ntfy directly. The same failure is
pushed once per 24 hours, not once per retry. A failed run is retried after
three hours; every path through the loop sleeps, so a failure cannot spin.

The sidecar cannot report its own absence. Something outside it must alert when
`latest.json` is older than about 36 hours or `restore-test.json` older than
eight days.

## Restoring for real

```bash
cd generations/<stamp> && sha256sum -c SHA256SUMS
createdb -h <host> -p <port> -U mindmeld conversations
pg_restore -h <host> -p <port> -U mindmeld -d conversations --no-owner --jobs=4 conversations.pgdump
```

Use `pg_restore` of the same major version as the dump (`pg_server_major` in
the manifest). For Chroma, stop the `chroma` service, extract
`chroma.tar.zst` into its empty data volume (`tar --zstd -xf`), and start it.

### Proving a Chroma restore searches

Counts cannot prove it: `count()` reads sqlite, so a store whose index lost
vectors still reports every row. Restore into a throwaway Chroma of the same
image on a free loopback port, sample ids, and query with the live vectors:

```bash
docker volume create chroma-restore
docker run --rm -v <generation dir>:/gen:ro -v chroma-restore:/restore --entrypoint sh   mindmeld-backup:local -c 'cd /restore && zstd -dc /gen/chroma.tar.zst | tar -xf -'
docker run --rm -v chroma-restore:/restore:ro -v <private dir>:/out --entrypoint sh   mindmeld-backup:local /opt/mindmeld-backup/chroma-sample-ids.sh
docker run -d --name chroma-restore -p 127.0.0.1:<free port>:8000 -v chroma-restore:/data <live chroma image id>
python -I scripts/backup/chroma-search-check.py http://127.0.0.1:8001 http://127.0.0.1:<free port> <private dir>
```

It fails when the restored store finds fewer sampled vectors in its own top 10
than live does (HNSW is approximate, and live misses some too). Remove the
container, the volume and the id files afterwards.

## Why Chroma is backed up at all

Its vectors are derived from Postgres, but not all of them cheaply. Session and
chunk summaries live in Postgres, so those vectors only need re-embedding. Some
message vectors were embedded from LLM summaries of long messages, and those
summaries are stored only in Chroma; losing it means re-running that
summarization on the GPU, at the rate quoted in `CLAUDE.md`, as well as
re-embedding every message.
