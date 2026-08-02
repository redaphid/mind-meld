---
name: mindmeld
description: Operate and debug the mindmeld conversation index — running a sync, reading its logs, checking data integrity, applying migrations, and understanding the container layout. Use whenever working on mindmeld itself, investigating why something is not indexed or not searchable, or touching the sync/embedding/summarization pipeline.
---

# Working on mindmeld

Mindmeld indexes Claude Code (and Android) conversations into Postgres + Chroma and serves them over MCP. Everything below was learned by debugging the running system; prefer it over guessing.

## Start here

`scripts/mm` is the entry point for day-to-day work. Use it before hand-writing docker or SQL commands.

```sh
scripts/mm status     # containers, counts, queue depth, health — run this first
scripts/mm doctor     # find data problems and how to fix them
scripts/mm logs       # real status lines only (see the log-noise warning below)
scripts/mm sync       # sync now instead of waiting for the timer
scripts/mm repair     # non-destructive fixes for what doctor finds
scripts/mm migrate    # apply migrations without needing psql installed
```

## The container layout

The source lives in the repo; the running system is containers. There is **no `sync` service in `docker-compose.yml`** — it was removed upstream for macOS and restored on this host by a gitignored `docker-compose.override.yml`.

| Container | Job | Interval |
|---|---|---|
| `mindmeld-sync` | `mindmeld sync` | `SYNC_INTERVAL_SECONDS=3600` |
| `mindmeld-sync-wsl` | same job, different source tree | 3600 |
| `mindmeld-warmups` | `pnpm mark:warmups` | 21600 (6h) |
| `mindmeld-centroids` | `pnpm compute:centroids` | 25200 (7h) |
| `mindmeld-mcp` | MCP HTTP server; **runs migrations on startup** | — |
| `mindmeld-postgres`, `mindmeld-chroma` | storage | — |

**These are sleep loops, not cron:** `while true; do <job> && sleep $INTERVAL; done`. The schedule floats relative to container start, and restarting one resets its phase. `docker restart` also kills any `docker exec` running inside it.

There are **two checkouts**. `mindmeld-sync-wsl` is defined by a compose file inside WSL (`\\wsl.localhost\survivor\home\hypnodroid\Projects\mind-meld`), not by this repo. Rebuilding the image fixes both containers only if both are recreated.

## Two phases, wildly different speeds

A sync run has a fast phase and a slow one. Do not assume it has hung.

1. **Message embedding** — batches of 50, quick.
2. **`--- Updating Aggregate Embeddings ---`** — LLM summarization of sessions, chunk by chunk. A single large session can take 10+ minutes, because oversized combined summaries get recursively re-chunked. This phase can run for hours and is lost entirely if the container restarts.

## Reading the logs (important)

The sync prints **indexed conversation content to stdout**, interleaved with its own status lines. A naive `docker logs mindmeld-sync | grep -i error` matches transcript text and produces confident-sounding false positives — including other people's message content.

Always anchor to line start. `scripts/mm logs` does this. Real status lines look like:

```
=== Sync starting at ... ===
--- Syncing Claude Code ---
Claude Code sync complete: 51 projects, 3 sessions, 692 messages
Failed to sync session <path>: error: ...
```

## Expected noise, not bugs

- `Failed to copy Cursor database: ENOENT ... state.vscdb` — Cursor is not installed in the container. Being removed (issue #32).
- `Batch failed (the input length exceeds the context length), re-embedding individually...` — self-healing. It rewrites oversized text smaller (`13703 -> 4007 chars`) and embeds that.
- Mid-sync count mismatches in `mm doctor` — a session being written right now. Re-check after the run.

## Data-integrity traps

**A failed insert makes a session invisible forever.** `syncSession` stamps `sessions.file_modified_at` *before* inserting messages, with no transaction. If an insert throws, the partial session keeps its stamp, and incremental sync skips that file on every subsequent run. Fixing the underlying error is not enough — the stamp must be cleared for the session to be retried. This is issue #21.

Detect it (catches both the never-synced and the partially-resynced variants):

```sql
SELECT s.id, s.message_count AS stored,
       (SELECT count(*) FROM messages m WHERE m.session_id = s.id) AS actual
FROM sessions s
WHERE s.message_count <> (SELECT count(*) FROM messages m WHERE m.session_id = s.id);
```

`mm repair` clears the stamps (retryable) and refreshes cached counts (source file gone). Both are non-destructive.

**A sync that fails still exits 0.** `stats.errors` fills up and the process returns normally, so the container loop treats a run that dropped sessions as a success (issue #29).

## Project paths are unreliable text

`decodeProjectPath` is lossy: hyphens become separators and dots are destroyed, so `D--mechs-win-setup` becomes `D:/mechs/win/setup` and `.claude` becomes `/claude`. Paths are corrected from `session.cwd` when a session has one, which means **stored paths mutate between syncs**.

Never look a project up by path text. Use `projects.external_id` (the raw encoded directory name) or the session's `external_id`. Searching `WHERE path ILIKE '%win-setup%'` will miss rows that are present. Issues #22 and #33.

## Database access

```sh
docker exec mindmeld-postgres psql -U mindmeld -d conversations -tAc "SELECT ..."
```

Database is `conversations`, user `mindmeld`, host port 5433. On Git Bash, prefix `docker exec` with `MSYS_NO_PATHCONV=1` when a container-absolute path is involved (`/app/mindmeld`), or the path gets rewritten into a Windows one.

`scripts/migrate.ts` shells out to the `psql` binary and therefore fails on Windows. Use `scripts/mm migrate`.

## Filing issues

Findings go to GitHub issues in `redaphid/mind-meld` with three labels — origin (`user-ask` / `claude-found` / `claude-idea`), priority (`critical` / `important` / `minor`), and a gate (`agent-ready` / `needs-human`). Issue #34 is the rulebook. Use `claude-found` only with cited evidence; otherwise it is `claude-idea`.

## Conventions

- Auth is handled by a proxy, never in the app. Do not add token checks or auth middleware.
- Tests are vitest, colocated as `*.test.ts`. Run `npx vitest run` and `npx tsc --noEmit` (pnpm is not on PATH on the Windows host).
