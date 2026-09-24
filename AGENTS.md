# mindmeld for agents

Mindmeld is a unified, searchable index of conversations — Claude Code
sessions, phone notifications and SMS, meeting transcripts, notes. If you were
asked "what did I say about X", "check my phone", or "find that conversation",
this is the system that answers it.

## STOP — MCP failing is not evidence that mindmeld is failing

> **If MCP is unavailable — authentication required, tools missing, or
> `HTTP 400 "No valid session ID"` — mindmeld is almost certainly still
> running. `curl http://127.0.0.1:3847` needs no authentication and no
> handshake. Try it before concluding anything is broken.**

```bash
curl -s http://127.0.0.1:3847/health
# {"status":"ok","name":"mindmeld","version":"1.21.0"}
```

Two different things put an agent through that wall, and neither one means the
service is down:

- **The `mindmeld` MCP server requires authentication in some sessions.** An
  agent reaching for MCP tools hits an auth prompt it cannot satisfy
  non-interactively, receives nothing, and reasonably concludes the service is
  unavailable. The HTTP API on `127.0.0.1:3847` is unauthenticated and
  unaffected. Use it.
- **A `mindmeld-mcp` container restart invalidates every live MCP session.**
  Clients then get `HTTP 400 "No valid session ID"`, which reads exactly like
  a dead server. **Reconnect, do not debug** — re-run the `initialize`
  handshake (see [MCP](#mcp)). Do not restart anything: other agents hold live
  sessions and a restart takes theirs down too.

This has now happened three times in one night — three separate agents
concluding mindmeld was broken or empty while it was healthy the whole time.
That pattern, not the feature list, is what this document exists to prevent.
Every failure so far has been a discoverability failure, not a missing
capability: agents have concluded there was no API at all, and that the user's
phone data did not exist. Both were wrong, and both are covered below.

**Read the [Traps](#traps-read-this-before-concluding-anything-is-broken)
section before concluding mindmeld is broken or empty.**

## Three routes in

| Route | Endpoint | Use it when |
| --- | --- | --- |
| **HTTP** | `http://127.0.0.1:3847`, no auth | **Default, and the reliable one.** Anything ad-hoc — you have `curl`, you get JSON. Never needs a handshake or a credential. |
| **MCP** | `POST http://127.0.0.1:3847/mcp` | You are an MCP client and want typed tools with disclosure ladders. **May require auth or be unavailable — if so, use HTTP; it is not a mindmeld outage.** |
| **CLI** | `mindmeld <cmd>` | Operating the system: sync, verify, status, config. Also the one search route with **no** `dataClass` filter. |

The UI is on `http://127.0.0.1:3848` (same API, reverse-proxied).

Live machine-readable spec: **`GET http://127.0.0.1:3847/openapi.yaml`**
(HTTP 200, ~120KB and growing). Prefer it over this document when the two
disagree about a parameter — it is generated from the running server. It is
being brought to 1.21.0 parity right now, so a gap there is likely staleness,
not absence.

Quick liveness check:

```bash
curl -s http://127.0.0.1:3847/health
# {"status":"ok","name":"mindmeld","version":"1.21.0"}
```

---

## Traps (read this before concluding anything is broken)

### 1. `dataClass` defaults to `coding` — personal and phone data is invisible

This is the single biggest one. A plain search silently searches **only coding
data**. The user's phone, SMS, notes, and meetings are all there and all
hidden.

```bash
# Sees ONLY coding data. Phone/SMS results are silently absent.
curl -s "http://127.0.0.1:3847/api/search?q=voicemail&mode=text&limit=3"

# Sees personal data.
curl -s "http://127.0.0.1:3847/api/search?q=voicemail&mode=text&limit=3&dataClass=personal"

# Sees everything.
curl -s "http://127.0.0.1:3847/api/search?q=voicemail&mode=text&limit=3&dataClass=*"
```

There are **two** escape hatches. Naming `source` explicitly also bypasses the
default, because an explicit source already says what you want:

```bash
curl -s "http://127.0.0.1:3847/api/search?q=voicemail&mode=text&limit=2&source=android"
```

The vocabulary is **open** — any lowercase label up to 32 chars — and only
`coding` is in the default search. Classes currently in use:

| dataClass | sources |
| --- | --- |
| `coding` | `claude_code`, `cursor`, `zora-coordinator` |
| `personal` | `android` (phone notifications + SMS) |
| `notes` | `vikunja`, `agent-ops` |
| `meetings` | `huddle` |
| `test` | `smoketest` |

`dataClass` accepts repeats or commas: `?dataClass=coding&dataClass=personal`
and `?dataClass=coding,personal` both work. A typo is a **400 that names the
valid vocabulary** — a cheap way to re-derive the list:

```bash
curl -s "http://127.0.0.1:3847/api/search?q=x&dataClass=nope&mode=text"
# {"status":"error","error":"Unknown dataClass value(s): nope. Valid values:
#  coding, meetings, notes, personal, test, or \"*\" for everything."}
```

### 2. For recent data use `mode=text` — the default `hybrid` will miss it

Full-text search sees a row **the instant it is written**. Only *semantic*
search waits on embedding, which is GPU-bound and can lag by hours. The
default mode is `hybrid`, whose vector arm can therefore silently miss
something ingested minutes ago.

**So: anything recent, pass `mode=text`.** Verified live — `mode=text` finds
notifications ingested minutes earlier and not yet embedded.

`mode=text` is **AND** semantics over tokens, so use 1–2 literal words, not a
phrase or a sentence. Verified:

```bash
# 1 result — both tokens matched
curl -s "http://127.0.0.1:3847/api/search?q=message+rates&mode=text&limit=1&dataClass=personal"
# 0 results — one unmatched token zeroes the whole query
curl -s "http://127.0.0.1:3847/api/search?q=message+zzzqqx&mode=text&limit=1&dataClass=personal"
```

Modes are `text`, `semantic`, `hybrid` (default). When the vector arm cannot be
reached, results come back from full text with `degraded` set — say so to the
user rather than reporting a clean miss.

### 3. Search results show the SESSION START date, not the message date

The `date` on a search result is when the *session* began. A months-old
session that received a message this morning still reports the old date.

Verified live: a session whose search result carried a `"date"` from days
earlier had `messages[].timestamp` values from the same morning. An agent
filtering on that `date` field would have thrown away today's data.

**To date something, read `messages[].timestamp`.** Never trust the search
`date` for recency.

### 4. `/api/sessions/<id>/messages` returns OLDEST FIRST

Reading the head of the array gives you the beginning of the conversation. For
"what just happened", **read the tail**. `limit` is capped at 100; the response
carries `nextOffset` / `nextStartMessageId` for paging, plus `fetched`,
`shown`, `budgetExhausted` (a 60k-char default budget, max 200k).

### 5. An MCP failure says nothing about mindmeld's health

The headline case is [at the top of this file](#stop--mcp-failing-is-not-evidence-that-mindmeld-is-failing);
the mechanics:

**Auth.** In some sessions the `mindmeld` MCP server requires authentication
that a non-interactive agent cannot complete. The tools are simply absent. This
is a client-side connector state — it does not touch the server, and the
unauthenticated HTTP API keeps working. Fall back to `curl`, do not report the
service as down.

**Restart.** After a `mindmeld-mcp` restart, existing MCP clients get:

```
HTTP 400  {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"},"id":null}
```

This reads like the server is down. **It is not** — the same error appears if
you simply call a method without completing the handshake. The transport is
fine and `/health` will answer normally. Re-run the `initialize` handshake and
carry on. Do not restart anything, and do not go hunting — other agents hold
live sessions and restarting takes theirs down too.

In both cases the fastest disambiguation is one unauthenticated request:
`curl -s http://127.0.0.1:3847/health`. If that answers, mindmeld is healthy
and the problem is confined to your MCP client.

### 6. Recover any request schema by POSTing `{}`

Zod validation errors name every required field and its type. Faster than
reading source:

```bash
curl -s -X POST http://127.0.0.1:3847/api/ingest -H 'Content-Type: application/json' -d '{}'
# {"success":false,"error":"Validation failed","details":[
#   {"path":["source"],"expected":"string","message":"Required"},
#   {"path":["project"],"expected":"object","message":"Required"},
#   {"path":["session"],"expected":"object","message":"Required"},
#   {"path":["messages"],"expected":"array","message":"Required"}]}
```

### 7. `mindmeld --version` prints `0.1.0`

It is hardcoded in `src/index.ts` and has drifted from `package.json`. The real
version is on `/health` and `/status` (`1.21.0`). Do not use the CLI's version
to decide anything.

---

## Phone / Android data ("check my phone")

Nothing in `docs/` covered this until now, and an agent asked to check the
user's phone previously concluded the data did not exist. It does.

**How it arrives:** push, sub-2-second. Tasker on the phone → a `life-log`
Cloudflare Worker → `POST /api/ingest`. There is **no poller, no cron, and no
sync container in this path**. `POST /api/ingest` writes synchronously and
never embeds — which is exactly why `mode=text` finds phone data immediately
and `mode=semantic` may not.

**Row shape:**

| Field | Value |
| --- | --- |
| `source` | `android` |
| `dataClass` | `personal` (hidden from the default search) |
| `project.externalId` | `phone` |
| session `external_id` | `notif:<package>:<title>` |
| message `role` | `contact` |
| `content_text` | `"<title>: <text>"` |

**Recipe — most recent phone activity** (newest first, no search involved, so
no embedding dependency at all):

```bash
curl -s "http://127.0.0.1:3847/api/sessions?source=android&limit=5"
```

Returns `total`, `count`, and `sessions[]` with `id`, `title`, `startedAt`,
`messageCount` — 185 android sessions at time of writing. Then read one:

```bash
curl -s "http://127.0.0.1:3847/api/sessions/<id>/messages?limit=100"
```

…and read the **tail** of `messages[]`, using `messages[].timestamp` for dates.

**Recipe — search the phone:**

```bash
curl -s "http://127.0.0.1:3847/api/search?q=<word>&mode=text&source=android&limit=10"
```

SMS threads live in the same source, titled `SMS with <contact>`.

---

## HTTP API

No authentication on `127.0.0.1`. Everything is `GET` unless noted.

| Endpoint | Notes |
| --- | --- |
| `/health` | Liveness + real version. |
| `/status` | Totals, per-source last-sync, pending embeddings, quarantine count, Chroma counts. |
| `/openapi.yaml` | Full live spec. |
| `/api/search` | `q` (required), `mode`, `limit` (max 100), `dataClass`, `source`, `since`, `cwd`, `projectOnly`, `not`, `includeAutomated`, `includeUnsummarized`. |
| `/api/sessions` | `limit` (max 200), `offset`, `source`, `projectId`, `machine`, `q`. |
| `/api/sessions/:id` | Digest: summary + chunk ladder. |
| `/api/sessions/:id/messages` | `limit` (max 100), `offset`, `startMessageId`, `endMessageId`, `maxChars`. **Oldest first.** |
| `/api/messages/:id` | One message, whole — the escape hatch for truncated content. |
| `/api/projects`, `/api/machines`, `/api/activity` | Inventory. |
| `/api/system`, `/api/summaries`, `/api/throughput`, `/api/embedding-series` | Why nothing is moving. |
| `/api/quarantine` | Records that failed to parse. Nothing is dropped. |
| `/api/stand-down` | `POST {minutes, reason}` to yield the GPU; `POST /api/stand-down/resume` to release. |
| `POST /api/ingest` | Open write. See below. |

### Ingesting

`POST /api/ingest` is idempotent — source/project/session upsert on
`externalId`, messages are insert-on-conflict-do-nothing. **Safe to replay.**
Verified end to end against the `smoketest` source:

```bash
curl -s -X POST http://127.0.0.1:3847/api/ingest -H 'Content-Type: application/json' -d '{
  "source": "smoketest",
  "project": { "externalId": "demo", "name": "demo" },
  "session": { "externalId": "demo-session", "title": "Example",
               "startedAt": "2026-08-08T00:00:00Z" },
  "messages": [{ "externalId": "demo-1", "role": "user",
                 "content": "Hello.", "timestamp": "2026-08-08T00:00:01Z",
                 "sequenceNum": 1 }]
}'
# 1st: {"success":true,...,"messagesInserted":1,"dataClass":"test"}
# 2nd: {"success":true,...,"messagesInserted":0,"dataClass":"test"}  <- idempotent
```

`dataClass` is **required only when the ingest would create a new source**, and
the error names the vocabulary if you omit it. An existing source's class is
never changed by ingest. Use `source: "smoketest"` for experiments.

---

## MCP

`POST http://127.0.0.1:3847/mcp`, streamable HTTP transport. You must complete
the `initialize` handshake and reuse the returned `mcp-session-id` header —
calling a method without it is the HTTP 400 in trap 5.

```bash
SID=$(curl -s -D - -o /dev/null -X POST http://127.0.0.1:3847/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' \
  | tr -d '\r' | awk -F': ' '/^mcp-session-id/{print $2}')

curl -s -X POST http://127.0.0.1:3847/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -s -X POST http://127.0.0.1:3847/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Responses are SSE framed (`event: message` / `data: {...}`) — strip the `data: `
prefix before parsing.

Tools: `search`, `getSession`, `getSessionTranscript`, `getMessages`,
`getMessage`, `getChunk`, `stats`, `health`, `reportUselessSession`.

The `dataClass` trap applies to the MCP `search` tool too.

---

## CLI

Built from `src/index.ts` to `dist/index.js`. If `dist/` is missing, the CLI
does not exist yet — build it:

```bash
cd D:/projects/mind-meld && pnpm install && npx tsc
node dist/index.js --help
```

Commands (all verified):

| Command | What it does |
| --- | --- |
| `mindmeld search <query>` | Full-text search. `-l/--limit`, `-s/--source`, `--full`. |
| `mindmeld status` | Per-source sync state, totals, Chroma collection counts. |
| `mindmeld config` | Resolved Postgres/Chroma/Ollama endpoints and paths. |
| `mindmeld sync` | Sync from disk. `-i/--incremental`, `-f/--full`, `-s/--source`, `--skip-embeddings`. |
| `mindmeld verify` | Compare session files on disk against the DB; nonzero on drift. `--repair`, `-p/--project`. |
| `mindmeld embeddings` | Generate pending embeddings (GPU-bound, slow). |
| `mindmeld start` / `stop` | **Linux only** — systemd user timer. Prints a clear message and does nothing on Windows. |

**The CLI `search` has no `dataClass` filter** — it queries the
`search_messages` SQL function directly and therefore sees *everything*,
including personal and phone data, with no flags. That makes it the fastest way
to check whether data exists at all before debugging a REST search:

```bash
mindmeld search "voicemail" --limit 3
# Found 3 results:
#
# [android] phone
#   Session: <SESSION_ID>  Message: <MESSAGE_ID>
#   Role: contact
#   Time: <ISO_TIMESTAMP>
#   Content: ...
```

Output carries `Session:` and `Message:` ids so you can drill in over HTTP
(`/api/sessions/<id>/messages`, `/api/messages/<id>`). Content is cut to 200
chars for readability — pass `--full` for the whole message.

Equivalent npm scripts exist and run from source via `tsx`, no build needed:
`pnpm run search "<q>"`, `pnpm run stats`, `pnpm run sync`, `pnpm run verify`,
`pnpm run quarantine`, `pnpm run db:migrate`.

### Getting `mindmeld` on PATH

The package declares `bin: {"mindmeld": "dist/index.js"}`, but that only takes
effect on install/link. On this Windows machine `%APPDATA%\npm` is already on
PATH, so shims live there — **no PATH edit required**:

- `%APPDATA%\npm\mindmeld.cmd` — cmd / PowerShell
- `%APPDATA%\npm\mindmeld` — Git Bash / POSIX shells

Both set `DOTENV_CONFIG_PATH` to the repo `.env` so `sync` and `embeddings`
(which need `OLLAMA_URL`) work from any directory, then exec
`node <repo>/dist/index.js`.

**Rollback:** delete those two files. Nothing else was changed.

Rebuild after editing `src/`: `npx tsc`. The shims point at `dist/`, so an
un-rebuilt change will not appear.

---

## Which route should I use?

- **"Find/what did the user say about X"** → `GET /api/search`, and set
  `dataClass` deliberately every single time.
- **"What just happened / check my phone"** → `GET /api/sessions?source=...`
  then read the message tail. No embedding dependency, no search semantics.
- **"Does this data exist at all?"** → `mindmeld search` (no dataClass filter).
- **"Is it broken?"** → `/health`, then `/status`, then `/api/system`. A stalled
  queue is usually the GPU gate holding work, not a fault.
- **Adding data** → `POST /api/ingest`, idempotent, replayable.

---

# Agent protocol for this repository

The rules below apply to any automated agent **working on this repo's code** —
whatever runtime it happens to be. They are project policy, not vendor-specific
tooling: no script has to be installed for them to apply.

## Non-negotiable rules

1. **Privacy — the repo is public**: never post or commit personal
   information, host paths outside the repo, device names/IDs, machine
   topology, credentials, or backup locations (issue #64). This is enforced
   mechanically by `src/quality/no-personal-data.test.ts`; if it fires,
   replace the value with a placeholder rather than deleting the check.
2. **Never push to main.** Feature branch (suffix `-<issue number>`), PR,
   review. Full test suite + `pnpm run type-check` + `pnpm run quality`
   before marking a PR ready for review.
3. **Honor operator comments**: re-fetch issue and PR comments before
   starting work AND before marking a PR ready. Every comment from the repo
   owner gets honored or answered with a reason — never ignored.
4. **Truthful labels**: `in-progress` only while actively working;
   `in-review` the moment a PR is up; `waiting-on-user`/`needs-human` only
   while genuinely blocked on the owner. A label that no longer describes
   reality is worse than no label.
5. **Validate issues before acting on them.** Issues go stale. Check the
   claim against live code and the database first, and comment with the
   evidence you found.
6. **No truncation** of data returned to API consumers — see CLAUDE.md.

## Deploys are semver-driven

Merging to `main` does **not** deploy. CI only builds images when
`package.json`'s `version` changes. Bump it deliberately; see CLAUDE.md.

## Do not restart containers casually

Restarting `mindmeld-mcp` invalidates every live MCP session held by every
other agent and user (trap 5). Treat it as a coordinated action, not a
debugging reflex.
