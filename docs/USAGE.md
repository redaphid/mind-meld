# Mindmeld Usage Guide

How to search the index and read what you find. Setup lives in
[DOCKER.md](DOCKER.md); the HTTP surface is specified in [openapi.yaml](openapi.yaml).

---

## The retrieval ladder

Mindmeld deliberately does **not** hand back whole transcripts. Every rung is
bounded, and each one tells you how to reach the next:

```
search           → one line per hit: session_id, title, score, matched_tier,
  │                snippet, and a cursor into the matching region
  └─ getSession  → digest: session summary + paged chunk manifest (no raw text)
       ├─ getChunk    → one chunk's full summary + its message-id range
       └─ getMessages → raw messages, windowed, capped at ~24K chars per call
            └─ getMessage → one oversized message, in full, on request
```

Two ways down the ladder, depending on what `search` gives you:

- **`cursor: { chunk_index }`** — the match was a chunk summary. Call
  `getSession` for the manifest, or `getChunk` for that one section, then read
  its `start_message_id`–`end_message_id` range with `getMessages`.
- **`cursor: { message_id }`** — the match was a specific message. Jump straight
  to `getMessages` around that id; skip the digest entirely.

`getMessages` returns *whole* messages up to its character budget. A single
message bigger than the whole budget comes back explicitly labelled
`[TRUNCATED — showing first N of M chars]` with a `getMessage({ id })` pointer.
That is the only place Mindmeld ever cuts content, and it is always recoverable.

---

## `search`

Runs up to four ranked arms — session vectors, chunk vectors, message vectors,
and Postgres full-text — and fuses them with reciprocal rank fusion. Sessions in
the `cwd` project get a flat score boost.

At least one of `query`, `likeSession`, `likeProject`, `unlikeSession`, or
`unlikeProject` is required; a query is not mandatory if you are steering purely
by centroid.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `query` | string | — | Natural language. Drives both the vector arms and full-text |
| `negativeQuery` | string | — | Subtracted from the query vector — semantic disambiguation |
| `excludeTerms` | string | — | Hard full-text exclusion; drops matching rows from the text arm |
| `limit` | number | `8` | Results returned after fusion |
| `mode` | `hybrid` \| `semantic` \| `text` | `hybrid` | Which arms run |
| `cwd` | string | — | Working directory. Matching projects get a `+0.5` score boost |
| `projectOnly` | boolean | `false` | Restrict to the `cwd` project instead of just boosting it |
| `since` | string | — | Time floor. See [formats](#since-formats) |
| `source` | string | — | `claude_code`, `android`, or any ingested source key. Naming a source bypasses the default `dataClass` filter |
| `dataClass` | string[] | `["coding"]` | Data classes to search. Every source carries a class (`coding`, `personal`, `meetings`, …; projects can override). `["*"]` searches everything; `["coding","personal"]` widens. Case-insensitive; an unknown value is rejected with the valid vocabulary |
| `likeSession` / `unlikeSession` | string[] | — | Weighted session centroids |
| `likeProject` / `unlikeProject` | string[] | — | Weighted project centroids |
| `includeAutomated` | boolean | `false` | Include non-interactive sessions (monitoring jobs, health checks, huddles). *stdio server only* |

Soft-deleted sessions are always excluded; so are automated ones unless you opt
in. By default only `coding`-class data is searched — SMS threads, notes, and
meeting transcripts stay out of a coding agent's results unless it widens
`dataClass` or names their `source` explicitly.

Each result carries `session_id`, `title`, `project`, `source`, `data_class`, `date`, `score`,
`matched_tier` (`session` \| `chunk` \| `message`), a snippet, and — for chunk
and message matches — a `cursor`.

### Recipes

**Find prior art before you write code.**

```jsonc
{ "query": "implementing OAuth2 refresh token rotation",
  "cwd": "/home/you/Projects/new-auth-service",
  "limit": 5 }
```

**Catch up on one project's recent week.**

```jsonc
{ "query": "API error handling",
  "cwd": "/home/you/Projects/api-gateway",
  "since": "7d",
  "projectOnly": true }
```

**Disambiguate an overloaded word.** `negativeQuery` pushes the query vector away
from a concept without filtering anything out:

```jsonc
{ "query": "workers", "negativeQuery": "employees HR hiring staffing" }
// Cloudflare Workers, not people
```

**Drop a noisy term entirely.** `excludeTerms` is a hard full-text filter, not a
nudge:

```jsonc
{ "query": "deployment rollback", "excludeTerms": "kubernetes helm" }
```

**Exact phrase only.** Skip the vector arms when you know the string:

```jsonc
{ "query": "OLLAMA_FLASH_ATTENTION", "mode": "text", "limit": 20 }
```

### `since` formats

Parsed leniently; an unparseable value is rejected at the schema layer with a
hint rather than crashing.

| Form | Examples |
| --- | --- |
| Relative duration | `7d`, `24h`, `2w`, `90m` |
| ISO-8601 duration | `P3D`, `PT12H`, `P1W` |
| Natural language | `yesterday`, `3 days ago`, `last week` |
| Absolute | `2026-01-15`, `2026-01-15T09:00:00Z` |
| Epoch | `1767225600`, `1767225600000` |

---

## Weighted centroid search

A **centroid** is the average embedding of a session's or project's content — a
vector for "work that feels like this." `like*` adds it to the query vector;
`unlike*` subtracts it, dampened by a factor of `0.2` so a negative can't
annihilate the query:

```
Q' = normalize(Q − N + Σ(w·C⁺) − Σ(0.2·w·C⁻))
```

Syntax is `"<id>"` or `"<id>:<weight>"`:

```jsonc
{ "query": "storefront rollout",
  "likeSession":   ["104057:1.5"],   // more like that deep-dive session
  "unlikeSession": ["98231:0.5"],    // less like that status-briefing session
  "likeProject":   ["12"] }
```

| Weight | Effect |
| --- | --- |
| `0.3`–`0.5` | Gentle nudge; results stay diverse |
| `1.0` | Standard influence (the default when no weight is given) |
| `1.2`–`1.5` | Noticeable bias toward that style |
| `2.0`+ | Aggressive; often over-filters |

**Centroids must exist first.** Ids without a stored `centroid_vector` are
silently skipped. Generate them with:

```bash
pnpm run sync:embeddings     # vectors first
pnpm run compute:centroids   # then the averages
```

The `mindmeld-centroids` container recomputes them every 7 hours
(`CENTROID_INTERVAL_SECONDS`).

---

## Reading a session

### `getSession`

Returns a **digest** — the session summary plus a paged manifest of its chunks.
No raw messages. A 96-chunk session would otherwise dump ~34K tokens of summaries
in one call, so the manifest itself pages.

| Parameter | Type | Default |
| --- | --- | --- |
| `sessionId` | number | required |
| `chunkOffset` | number | `0` |
| `chunkLimit` | number | `20` |

Each manifest entry is `{ index, summary, start_message_id, end_message_id, chars }`.
A chunk is a **section summary** standing in for a span of ~dozens of messages —
not a per-message summary. When a session has no summary yet, the digest carries
a labelled `excerpt` instead, so triage is never blind.

### `getChunk`

One chunk's full summary plus its message range, for when the one-line manifest
entry isn't enough to decide whether to read the raw text.

```jsonc
{ "sessionId": 104057, "chunkIndex": 7 }
```

### `getMessages`

Raw messages, in two modes:

```jsonc
{ "sessionId": 104057, "offset": 0, "limit": 30 }        // browse a window
{ "startMessageId": 88120, "endMessageId": 88240 }        // read a chunk's region
```

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `sessionId` | number | — | Required for windowed browse; inferred for a range read |
| `offset` / `limit` | number | `0` / `30` | Window mode |
| `startMessageId` / `endMessageId` | number | — | Range mode; must be supplied together |
| `maxChars` | number | `24000` | Character budget for the whole call |

The response reports `shown` vs `fetched`, whether the budget was exhausted, and
the cursor for the next page (`next_offset` or `next_start_message_id`).

### `getMessage`

One message by id, uncapped. The escape hatch for anything `getMessages` returned
as `TRUNCATED`. Reaching a 271K-character message takes this deliberate call — it
can never arrive by accident.

---

## Housekeeping tools

### `stats`

Session and message counts per source (with each source's `data_class`) and
aggregated per data class; the stdio server also returns the top 10 projects.
No parameters.

### `health` *(stdio server only)*

Whether the pipeline is keeping up or degrading quietly:

- **Summary coverage** — sessions with a summary vs the real NULL backlog
- **Summary quality** — bad summaries by signal (`too_short`, `over_compressed`,
  `raw_message_leak`, `code_dump`, `refusal`, `loopy`, `truncated`, …)
- **Embedding freshness** — age of the newest `convo-sessions` and
  `convo-messages` vectors, plus the pending count

Over HTTP, `GET /status` covers the sync and backlog half of this.

### `reportUselessSession`

Soft-deletes a session so it stops appearing in search. Use it the moment search
returns obvious noise — automated runs, monitoring jobs, boilerplate. The row is
kept; only `deleted_at` is set.

```jsonc
{ "sessionId": 98231, "reason": "hourly monitoring job, no interactive content" }
```

### `getSessionTranscript` *(stdio server only)*

Resolves a session by `external_id` or a title `ILIKE` match and returns its
digest. Despite the name it does **not** return raw messages — use `getMessages`
for that.

---

## The `context` prompt *(stdio server only)*

An MCP prompt, not a tool. Given `{ cwd, task? }` it lists the 10 most recent
sessions for the projects matching that path — a cheap orientation step before
you start searching.

---

## Pipeline timing

What runs when, so you know why something isn't findable yet:

| Stage | Cadence | Effect |
| --- | --- | --- |
| Sync | Hourly, per machine (systemd timer / launchd) | New messages become **full-text** searchable immediately |
| Summarize + chunk | During sync, via `OLLAMA_URL` | Session and chunk summaries appear |
| Embeddings | During sync, or `pnpm run sync:embeddings` | Messages become **semantically** searchable |
| Centroids | Every 7 hours (`mindmeld-centroids`) | `like*` / `unlike*` become usable for new sessions |
| Warmup filter | Every 6 hours (`mindmeld-warmups`) | Warmup/automated sessions get flagged out of results |

Ingested conversations (`POST /api/ingest`) skip sync but still wait for the next
embedding run before semantic search finds them. An ingest that would create a
**new** source must say what class of data it is (`dataClass: "meetings"`,
`"personal"`, `"coding"`, … — open vocabulary, lowercase) or it is rejected
with `400`; the error names the classes already in use. Existing sources keep
their class — ingest never reclassifies — and only `coding`-class data is
visible to the default `search`. See `docs/openapi.yaml` for the full payload.
