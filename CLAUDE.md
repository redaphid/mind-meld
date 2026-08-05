# Mindmeld - Unified Conversation Index

Mindmeld syncs conversations from Claude Code into a unified PostgreSQL + Chroma database for full-text and semantic search across all AI conversations.

## Ports (Non-Standard to Avoid Conflicts)

| Service    | Port     | Purpose                    |
| ---------- | -------- | -------------------------- |
| PostgreSQL | **5433** | Metadata + full-text search |
| Chroma     | **8001** | Vector embeddings          |
| MCP        | **3847** | HTTP API for Claude Code   |

## Local Development Setup

```bash
# Install dependencies
pnpm install

# Copy and configure environment
cp .env.example .env

# Run manual sync
pnpm run sync
```

## Commands

```bash
pnpm run sync              # Full sync (incremental by default)
pnpm run sync -- --full    # Force full re-sync

pnpm run sync:embeddings        # Generate pending embeddings
pnpm run compute:centroids # Compute session/project centroids for weighted search
pnpm run search "query"    # Search conversations
pnpm run stats             # Show sync statistics

pnpm run verify            # Compare session files on disk against the DB; exits nonzero on drift
pnpm run verify --repair   # Also clear the sync stamp on drifted sessions and recompute stats
```

A sync run that records any error exits nonzero and prints a per-run summary
(sessions, messages, skipped, quarantined, every error in full), so container
monitoring sees failures instead of an eternal exit 0.

## Web UI

The browser app lives in `public/`. It runs as its own container: the `ui`
compose service (`Dockerfile.ui`, image `mindmeld-ui`, host port 3848) serves
`public/` at `/` and reverse-proxies the API surface (`/mcp`, `/api`,
`/status`, `/health`, `/logs`, `/openapi.yaml`) to the `mcp` service — the
Cloudflare tunnel's public hostname (e.g. mindmeld.example.com) points at
`http://ui:3000`, one ingress rule, every path works. The `mcp` service (port
3847) still serves the same files at `/` as a fallback, so it stays fully
usable standalone and the tunnel keeps working during migration either way.

No build step: Preact and htm are vendored under `public/vendor/` and loaded
through an import map, so what is committed is what runs — edit a file, reload
the page.

- Views: status, search (vector / full-text / hybrid), browse, session reader,
  logs, quarantine.
- Search and browse rows climb the same ladder the MCP tools do — title →
  session summary → section summaries → messages (`public/js/disclosure.js`),
  each rung fetched only when opened and rendered in place, so drilling never
  loses your position in the list. A search hit opens one rung deeper: at its
  matched section, or at its matched message. The bottom rung is shared with
  the full-page reader (`public/js/messages.js`) so "reading messages" behaves
  identically wherever you arrived from.
- It is a PWA: installable, and the service worker keeps the last state readable
  when the tunnel drops. Bump `VERSION` in `public/sw.js` when shell files
  change — **enforced, not remembered** (issue #113): `src/quality/service-worker-freshness.test.ts`
  hashes every asset in the `SHELL` list against `quality/service-worker-shell.json`
  and fails when one moves without a bump. It also fails when a `public/js`
  module is missing from `SHELL` (never precached) or a `SHELL` entry no longer
  exists (`Promise.allSettled` swallows the 404). After bumping `VERSION`,
  re-record with `pnpm run quality:sw-shell -- --update`; it refuses to write
  while `VERSION` is unchanged, because re-recording is the second half of the
  fix, not a way to silence the check.
- Icons are generated, not hand-drawn: `pnpm run icons`.

Reaching either service through the Cloudflare tunnel requires that hostname in
`ALLOWED_HOSTS` (comma-separated, added to the localhost defaults; both `ui`
and `mcp` read the same variable). There is no authentication — see the
trust-model note in `docs/openapi.yaml`.

## Diagnosing throughput (do not trust `pending` on its own)

`/status` and `/api/throughput` can report a five-figure backlog, a rate near
zero and an ETA years out while the message queue is in fact **fully caught
up**. Observed 2026-08-03: `pending: 32339`, `0.07 msg/min`, `state: draining`,
ETA 2027-10-27 — while the embedder's own predicate returned **0** rows of real
work. Nothing was slow; the number was wrong.

### One definition of "pending" — `src/embeddings/pending.ts`

This was the bug. The **counter** (`queue.pending` in `src/mcp/throughput.ts`,
`pendingEmbeddings.messages` on `/status`) asked only: `content_text` is
non-null, longer than 10 chars, no `convo-messages` row. The **embedder**
(`getMessagesToEmbed`) additionally required *all* of:

- `m.role <> 'tool'`
- `s.deleted_at IS NULL` — not in a deleted session
- `s.is_automated = false`
- no `UNEMBEDDABLE` row — the marker written for noise, and for NaN-blocked
  text past its retry budget

Everything in that gap was **counted forever and worked never**. Of the 32,339
above: 30,961 noise-marked `UNEMBEDDABLE`, 1,376 in deleted sessions, 2 tool
messages — summing to exactly the reported backlog. Because the residue never
shrank, `state` also stuck on `draining` and the ETA came from arrival noise.

The predicate now lives in **one place**, `src/embeddings/pending.ts`, and both
sides import it: `getMessagesToEmbed` / `updateAggregateEmbeddings` select the
rows, `throughput.ts` and `/status` count them. A number the UI shows is the
number a worker acts on, and that holds because it is the same SQL — not
because two copies were checked against each other.

**Do not restate either predicate.** If a new screen needs a pending count,
import `pendingMessagesCount` / `pendingSessionsCount`; if it needs the rows,
import `embeddableMessages` / `embeddableSessions`. The failure mode is silent
and takes five figures to notice.

Sessions carry one deliberate asymmetry worth knowing: a session that ended
less than 30 minutes ago is excluded on **both** sides, because re-summarizing
a live conversation as it grows is waste. It is deferred work, not queued work.

To check the queue independently of any application code:

```sql
-- real remaining message work; 0 means caught up no matter what /status says
SELECT COUNT(*) FROM messages m
JOIN sessions s ON m.session_id = s.id
LEFT JOIN embeddings e ON e.message_id = m.id AND e.chroma_collection = 'convo-messages'
LEFT JOIN embeddings skip ON skip.message_id = m.id AND skip.chroma_collection = 'UNEMBEDDABLE'
WHERE m.content_text IS NOT NULL AND LENGTH(m.content_text) > 10
  AND m.role <> 'tool' AND s.deleted_at IS NULL AND s.is_automated = false
  AND e.id IS NULL AND skip.id IS NULL;
```

Run it with `docker exec mindmeld-postgres psql -U mindmeld -d conversations`.
A useful second question is *what shape* the residue is — a backlog whose
"short, fast path" bucket averages ~80 chars is noise, not work.

### The queue is global and nothing claims a row

`runPendingEmbeddings` → `generatePendingEmbeddings` / `updateAggregateEmbeddings`
select from a **global** queue with no `FOR UPDATE SKIP LOCKED` and no advisory
lock anywhere in `src/embeddings/batch.ts`, `src/mcp/sync-run.ts` or
`src/sync/orchestrator.ts`. Every process that runs a sync drains the same
rows, so **workers duplicate each other's LLM work**. In a default deployment
that is at least three: the `mcp` service (the HTTP/UI server runs the queue
too, and can be the single largest GPU consumer), the `sync` worker, and any
per-machine sync loop — which runs a *full global* pass once per machine
folder, not a pass scoped to that machine.

Measured over 90 minutes: 339 chunk summarization passes to cover 250 needed
chunks (**1.36x redundancy**); one 8-chunk session received 24 passes; 37 of 45
sessions were worked by more than one worker concurrently.

When two workers land on the same session, the collision **destroys completed
work**: `persistSessionChunks` upserts the `session_chunks` row with
`ON CONFLICT DO UPDATE`, then inserts that chunk's `embeddings` row with a
**bare INSERT**, which violates the unique `embeddings_session_chunk_idx`
(`session_chunk_id, chroma_collection`). The loser's minutes of LLM output are
thrown away and logged as `Failed to update session N embedding: duplicate
key`. The session-level write in `batch.ts` does the same operation correctly
with `ON CONFLICT DO UPDATE` — the chunk path just lacks it. Neither the lock
nor the `ON CONFLICT` is fixed yet.

Find duplicated work from the `logs` table:

```sql
WITH s AS (
  SELECT machine || '/' || service AS who,
         substring(message from 'for session ([0-9]+)') AS sess
  FROM logs
  WHERE message LIKE 'Summarizing chunk%'
    AND logged_at > now() - interval '90 minutes'
)
SELECT sess, COUNT(DISTINCT who) AS workers, COUNT(*) AS chunk_passes
FROM s WHERE sess IS NOT NULL
GROUP BY sess HAVING COUNT(DISTINCT who) > 1
ORDER BY chunk_passes DESC;
```

### Why summarization is genuinely slow

Session summarization is the real cost, and it is legitimately expensive: a
chunk pass measures 18–110s, a long session is ~8 chunks, so 5–10 minutes per
session — serialized on one GPU shared with every other tenant on the host.
`nvidia-smi` plus Ollama's `/api/ps` tell you whether the models resident in
VRAM are even yours: a chat model you do not use sitting in VRAM means someone
else is competing for the card. ~36 sessions/hour is a realistic ceiling, and
duplicate work comes straight off it.

### Traps that have cost real time

- `OLLAMA_EMBEDDING_URL` (a second, flash-off Ollama on `:21434`) was removed in
  1.7.0 — everything goes through `OLLAMA_URL`. It lingered in
  `docker-compose.yml` long after the docs said it was gone, and cost debugging
  time as a suspect. If an old `.env` or systemd unit still sets it, it is
  ignored; it cannot cause an embedding problem.
- Stack traces distinguish the workers: `/$bunfs/root/mindmeld` is the
  Bun-compiled `sync` image, `/app/src/...` is the tsx-based `mcp` image. Both
  appearing for one session is proof of concurrent duplicate work.
- A summarizing queue looks stalled to message-rate metrics; see #109/#111 and
  the ranked verdicts in `throughput.ts`.

## When sync cannot process a record

Nothing is dropped. A record that fails to parse or insert goes to
`sync_quarantine` whole — raw bytes, base64 so nothing in them can break the
copy — and the rest of the session still indexes.

```bash
pnpm run quarantine            # what is waiting, and why
pnpm run quarantine -- --retry # replay it
```

Also at `/#/quarantine` in the UI, and `GET /api/quarantine` /
`POST /api/quarantine/retry`. `quarantined` on `/status` is the number to alert
on: non-zero means data is waiting, not lost.

## Search

### Weighted Centroid Search

Advanced semantic search using session and project centroids (average embeddings):

**Setup:**
```bash
# 1. Generate embeddings first
pnpm run sync:embeddings

# 2. Compute centroids (session and project averages)
pnpm run compute:centroids
```

**MCP Search Parameters:**
- `likeSession`: Boost results similar to specific session(s) style
- `unlikeSession`: Suppress results similar to specific session(s)
- `likeProject`: Boost results matching specific project(s) topics
- `unlikeProject`: Suppress results matching specific project(s)

**Weight Syntax:**
- Simple: `["123"]` - Default weight 1.0
- Weighted: `["123:1.5"]` - 1.5x boost
- Multiple: `["123:1.5", "456:0.5"]` - Combine multiple

**Weight Scale:**
- `0.3-0.5`: Gentle nudge, diverse results
- `1.0`: Standard influence (default)
- `1.2-1.5`: Noticeable bias, strong preference
- `2.0+`: Aggressive, may over-filter

**Example:**
```typescript
// Find sessions similar to session 104057 but not like briefing sessions
{
  query: "storefronts implementation",
  likeSession: ["104057:1.5"],
  unlikeSession: ["briefing-session:0.5"],
  cwd: "/Users/you/Projects/acme/storefronts"
}
```

**Algorithm:** Uses Rocchio with 0.2 dampening for negative weights:
```
Q' = Q - γN + Σ(w * C+) - Σ(γw * C-)
where γ = 0.2 (prevents over-suppression)
```

Centroids are automatically recomputed every 7 hours by the `mindmeld-centroids` Docker container. Adjust via `CENTROID_INTERVAL_SECONDS` in `.env`.

### SQL Search

```sql
-- Full-text search
SELECT * FROM search_messages('your query', 50, 'claude_code');

-- Recent sessions
SELECT * FROM v_session_summaries
ORDER BY started_at DESC
LIMIT 20;

-- Tool usage stats
SELECT * FROM v_tool_stats;
```

## Development

**Run `pnpm install` first, and again whenever a check fails on a missing
module.** `node_modules` here drifts from `package.json` — the sync worker runs
from source on the host while the containers ship their own bundled deps, so
nothing forces a reinstall when dependencies change under you. It presents as a
type error in a file you did not touch:

```
src/__tests__/workflows.test.ts(15,23): error TS2307: Cannot find module 'yaml'
```

That is a stale install, not a broken import — `yaml` was listed in
`package.json` the whole time. `pnpm install` fixed it, adding `yaml`, `knip`,
and `@vitest/coverage-v8` and removing four packages that were no longer
declared. Reach for `pnpm install` before you debug the import.

```bash
# Install/refresh dependencies — do this first
pnpm install

# Reset database
pnpm run db:reset

# Watch mode
pnpm run dev

# Type check
pnpm run type-check
```

## This repository is PUBLIC (issue #64)

Nothing personal may be committed: no usernames, home-directory paths, device
or machine names, machine topology, tunnel hostnames, or credentials. Use
placeholders instead — `/home/<user>`, `\\wsl.localhost\<distro>\...`,
`mindmeld.example.com`, `<your-username>` — and keep the surrounding
explanation, so the docs stay followable by a stranger.

This is enforced mechanically, not by good intentions:
`src/quality/no-personal-data.test.ts` scans every git-tracked file on each
test run and fails on personal-path shapes and on banned terms listed (as
SHA-256 hashes, never plaintext) in `quality/personal-terms.json`.

If it fires, **replace the value with a placeholder** — do not delete the hash
or add an exception. Failures report file and line only, never the matched
text, because this repo's CI logs are public too.

Real host-specific values belong in your `.env` (see `.env.example`), which is
not tracked.

## Deployment

Deploys are **semver-driven** — CI only builds images when `package.json`'s `version` changes. A plain merge to `main` does **not** deploy.

1. Bump `version` in `package.json` and push to `main`.
2. `.github/workflows/release.yml` (gated on `paths: ["package.json"]`) runs tests + build, then creates a GitHub Release with a `v{version}` tag.
3. `.github/workflows/docker-publish.yml` (on the `v*` tag / after Release completes) builds and pushes all images to GHCR: `mindmeld-sync` (`Dockerfile.sync`), `mindmeld-mcp` (`Dockerfile.http`), plus postgres/centroids/warmups. Image suffix = the matrix `image:` value, so `Dockerfile.http → mindmeld-mcp` (matches what compose pulls).
4. On the host: `docker compose pull && docker compose up -d`. Migrations auto-apply on `mcp` startup (`src/db/migrations.ts`).

`/deploy` (`.claude/commands/deploy.md`) automates the push → tag → CI-watch → pull → restart, but it reads the existing version and does **not** bump it — edit `package.json` first.

## Shared definitions over restated ones

**When the same rule lives in two places, extract it into one — take the obvious
refactor rather than leaving copies to be kept in step by hand.** Duplicated
rules drift, and they drift silently: nothing fails, the two answers simply stop
agreeing and the wrong one ends up on a screen.

Take the refactor when you see:

- the same SQL predicate in a thing that *selects* rows and a thing that
  *counts* or *displays* them
- the same magic number, threshold, model name, or status string in more than
  one module
- a literal repeated between code and its test, so the test would follow the
  code into being wrong
- a list that must match another list (assets, collections, migrations)

The loudest signal: **if you are about to write a comment asserting that two
pieces of code agree, make them the same piece of code instead.** That comment
is a promise nothing enforces. Where sharing genuinely isn't possible, enforce
the agreement mechanically — a test that hashes both sides — the way
`quality/service-worker-shell.json` pins the service-worker `SHELL` list.

What it costs when skipped, from this repo:

- `src/embeddings/pending.ts` exists because "pending" was written twice, and
  the copies diverged into a dashboard advertising a 32,339-message backlog and
  an ETA 14 months out against **zero** real work. The comment above
  `getThroughput` had claimed for months that the two predicates "deliberately
  match". They never did.

Two caveats, so this doesn't become cargo cult:

- Keep the *reasoning* with the definition, not at the call sites — one place to
  read, one place to update.
- Don't merge things that merely look alike. Two predicates that answer
  different questions should stay separate, with a comment saying why they
  resemble each other and must not be unified.

## No Truncation Policy

Never truncate strings returned to API consumers. This includes `.slice()`, `substring()`, or SQL `LEFT()`/`SUBSTRING()` on data returned by MCP tools or HTTP endpoints. If content is too large, use summaries (LLM-generated) or pagination (offset/limit) instead. Truncation silently destroys information and makes results useless for downstream LLMs.

Acceptable truncation: debug logging (`console.log`), embedding model input limits (model constraint, not a choice).
