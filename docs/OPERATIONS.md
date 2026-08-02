# Operations

Day-2 guide: what to run when something looks wrong. For installation see
[DOCKER.md](DOCKER.md); for querying the index see [USAGE.md](USAGE.md).

Everything here goes through `scripts/mm`, which works on Windows (Git Bash),
WSL, Linux, and macOS. The older scripts in `scripts/` are macOS-only — they
call `osascript` or run under zsh, and do nothing useful elsewhere.

```sh
scripts/mm help
```

## The 30-second check

```sh
scripts/mm status
```

Shows which containers are up, how much is indexed, how many messages are
waiting to be embedded, when the last sync finished, and whether any session is
in an inconsistent state.

For a live view while something is running:

```sh
scripts/mm watch        # refreshes every 10s
scripts/mm watch 30     # or pick an interval
```

## "My conversation isn't showing up in search"

Work down this list.

**1. Has it been synced yet?** Syncs run hourly on a timer, not immediately.

```sh
scripts/mm sync
```

**2. Did the session fail to insert?**

```sh
scripts/mm doctor
```

A session whose insert failed keeps its "already synced" stamp, so every later
sync skips it — fixing the underlying bug does not bring it back on its own.
`mm repair` clears those stamps; the next sync re-reads the file.

```sh
scripts/mm repair --dry-run     # see the plan
scripts/mm repair               # apply it
scripts/mm sync                 # re-read the cleared sessions
```

Both repairs are non-destructive: one clears sync bookkeeping, the other
recomputes cached counters. No message or session is deleted.

**3. Is it embedded but not summarized?** `mm status` shows the embedding queue
depth. Messages are searchable once embedded; session-level summaries come from
the much slower aggregate phase.

**4. Is it a source this machine cannot see?** Each sync container only mounts
one transcript tree. A session recorded in WSL is repaired by the WSL sync, not
this one. `mm doctor` prints the project's raw directory name, which tells you
where it came from.

## "The sync looks stuck"

It probably is not. A run has two phases, and the second is slow by nature:

```
--- Generating Embeddings ---          fast, batches of 50
--- Updating Aggregate Embeddings ---  LLM summarization, minutes per session
```

A single large session can take over ten minutes, because oversized combined
summaries are recursively re-chunked and re-summarized. Check that it is moving:

```sh
scripts/mm logs -f
```

This phase does not survive a container restart. Avoid `docker restart` or a
redeploy while it is running unless you are willing to lose that work.

## Reading logs without fooling yourself

The sync prints **indexed conversation content** to stdout, mixed in with its
own status lines. So this lies to you:

```sh
docker logs mindmeld-sync | grep -i error     # matches transcript text
```

It will match the word "error" inside someone's indexed message and report a
problem that does not exist. `scripts/mm logs` anchors patterns to line start
and shows only real status lines. Use `scripts/mm logs -a` for raw output when
you genuinely want everything.

## Applying migrations

```sh
scripts/mm migrate
```

The documented path (`pnpm db:migrate`) shells out to the `psql` binary, which
is not installed on Windows. `mm migrate` pipes the SQL through the postgres
container instead, so it works anywhere Docker does. Migrations are written to
be idempotent — re-running is safe.

The MCP server also applies migrations on startup. The sync container does not,
so a sync image built from a newer commit can start writing to a schema that
does not support it. If you see `column ... does not exist`, run `mm migrate`.

## Understanding the schedule

Jobs are **sleep loops, not cron**:

```sh
while true; do <job> && sleep ${INTERVAL}; done
```

| Container | Interval |
|---|---|
| `mindmeld-sync`, `mindmeld-sync-wsl` | 1h |
| `mindmeld-warmups` | 6h |
| `mindmeld-centroids` | 7h |

Two consequences:

- The schedule floats relative to when each container started. Restarting one
  resets its phase — that is the simplest way to force a run onto a new cadence.
- `docker restart` kills any `docker exec` running inside that container,
  including a manual `mm sync`.

## Looking at the data directly

```sh
scripts/mm psql
```

Database `conversations`, user `mindmeld`, host port 5433.

**Do not look a project up by path.** Stored paths are lossy and change between
syncs: `D--mechs-win-setup` decodes to `D:/mechs/win/setup`, and `.claude`
becomes `/claude`. A path is corrected later from the session's `cwd`, so the
same project has different text at different times. Query by
`projects.external_id` (the raw directory name) or a session's `external_id`.

## Seeing failures without going looking

Container errors are otherwise invisible until someone reads the logs. If a
monitoring stack is set up on the host (Dozzle for browsing, a log watcher for
push alerts), point it at these containers. Filters must be anchored to line
start for the reason described above, or indexed conversation content will
trigger false alerts — and those alerts will contain message text.
