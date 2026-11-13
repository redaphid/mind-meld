# Retrieval benchmark

A frozen set of search queries with graded relevance judgments, used to accept
or reject changes to search ranking and speed. `noise:eval` measures only
whether the noise penalty separates reported noise from real sessions. This
harness measures whether search finds the right conversation.

The queries, judgments and runs quote a personal index, so they live in a
bench directory outside this repository. Every command needs `--dir <bench>`
or `MINDMELD_BENCH_DIR`, and refuses a path inside the repository.

## What it measures

Each query belongs to one stratum:

| Stratum | Query | Gold |
|---|---|---|
| `natural` | written by Haiku from a session, as its owner would type it later | that session |
| `paraphrase` | same, sharing no stemmed content word with the text shown to the writer (checked in code, regenerated on overlap) | that session |
| `keyword` | an identifier, error string or file name copied verbatim from the session (checked in code) | that session |
| `crossclass` | `natural`-style, gold in the `personal` or `notes` class, searched with `dataClass: ["*"]` | that session |
| `noanswer` | gibberish, or a plausible topic verified absent (no full-text hit, every top-5 semantic hit judged at most marginal) | none |
| `real` | an agent's own search recovered from indexed transcripts, replayed with its `dataClass`, `cwd`, `since` and `projectOnly` | the listed sessions it opened before its next search (weak gold) |
| `steering` | a topic query plus example sessions to steer toward and away from (`bench:steer`) | sessions judged relevant; off-target sessions judged irrelevant |

`paraphrase` is biased against full-text search by construction. Reports
label it `biasedAgainst: "text"`, and the `headline` group (natural, keyword,
crossclass, real) leaves it out.

Per stratum, with 95% percentile-bootstrap intervals over queries:
nDCG@10, gold MRR, gold recall@10, mean grade of the top 5, junk@5 (share of
the top 5 graded 0), no-answer false-positive rate (any result on a
`noanswer` query), and latency p50/p90 over non-degraded runs. The `headline`
group is also split by whether the gold session's summary is a generated one
or raw transcript text. `bench:compare` reports b minus a for every metric as
a paired bootstrap (10,000 resamples, fixed seed) and whether its interval
excludes 0.

## Judging

Haiku grades each (query, session) pair 0 to 3 from the session's title,
summary, section summaries, sampled messages and up to two matched snippets.
It sees several candidates per call in a seeded random order, and is never
told which system returned which or which is gold. Judgments are an
append-only cache keyed by (query, session, prompt version): a pair is judged
once, so a new system only costs the pairs it newly puts in a top ten. A
result nobody judged counts as grade 0, and reports say how many there were.

Judge calls go through `claude -p` with no session persistence, no settings,
hooks, plugins, MCP servers or tools, a replacement system prompt and an empty
working directory (`src/bench/claude.ts`). Claude Code transcripts are what
mindmeld indexes, so a persisted judge call would put queries and their
answers into the corpus being measured.

`bench:validate` reports gold sanity (share of gold sessions the judge grades
2 or 3), test-retest agreement on a seeded tenth of the pairs (exact and
quadratic-weighted kappa), and agreement with an independent grader on 60
pairs exported to the bench directory.

## Integrity

- The corpus snapshot is the largest session id when the set was built.
  Results above it are ignored, so later ingestion, including the transcripts
  of whoever runs the benchmark, cannot move a score.
- `--exclude-path` drops sessions by transcript path, for the conversations
  that built the set.
- A `real` query ignores its own transcript and anything that started after it.
- `bench:freeze` stamps the query-set hash, counts and harness commit into the
  manifest; scoring refuses a frozen set whose queries changed.

## Commands

```bash
pnpm run bench:build -- --dir <bench> --seed <seed> [--config systems.json] [--exclude-path '<LIKE pattern>']
pnpm run bench:freeze -- --dir <bench> [--note "..."]
pnpm run bench -- --dir <bench> --system text --system semantic --system hybrid --name <run>
pnpm run bench:compare -- --dir <bench> --a <run>-text --b <run>-semantic
pnpm run bench:validate -- --dir <bench> --retest --export-opus
pnpm run bench:steer -- --dir <bench> --config systems.json --build --seed <seed>
pnpm run bench:steer -- --dir <bench> --config systems.json --name <run>
```

`bench` runs the named systems one search at a time, interleaved per query
with the first system rotating, so their latencies are comparable. It retries
a degraded search twice and reports how many stayed degraded. It prints one
JSON line per system and saves runs under `<bench>/runs`, resuming a run of
the same name.

Search embeds the query through `OLLAMA_URL`. A host-side run needs a URL the
host can reach (for example `http://127.0.0.1:<gate port>`); a container
hostname there times out and every semantic search comes back degraded.

## Defining a system

Built-in systems are `text`, `semantic`, `hybrid`, `hybrid-noise-off`,
`hybrid-no-cwd`, `hybrid-gold-cwd`, and the broken controls
`hybrid-reversed` and `hybrid-shuffled` (the saved `hybrid` run reordered).
A `--config` file adds or overrides systems without touching the query set:

```json
{
  "systems": {
    "hybrid-boost-0.1": { "module": "../other-checkout/src/mcp/search.ts", "params": { "mode": "hybrid" } },
    "hybrid-20-away": { "params": { "mode": "hybrid", "limit": 20 }, "steer": "away" }
  }
}
```

`params` merge over the query's own; `module` is any file exporting
`searchWithDiagnostics`; `cwd` is `query`, `none` or `gold`; `steer` hands a
steering item's examples to search as `likeSession` / `unlikeSession` and as
`params.steering`.

## Known weaknesses

- One judge model. Its agreement with an independent grader is measured, not
  assumed, but systematic leniency shared by both would not show.
- Generated queries are written from what the writer was shown; `paraphrase`
  avoids those words, not every word in a long session.
- `real` gold is what an agent opened from the ranker of the day, so it
  favours results that ranker surfaced.
- Sessions below the snapshot can still gain messages, chunks and vectors.
- Pairs are judged once, with the snippets the first pooled systems produced.
