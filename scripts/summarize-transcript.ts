// Summarize a transcript through the REAL pipeline and print the final summary.
//
// Transcript in, summary out — no database, no Chroma, no writes. It calls the
// same buildChunkTexts / summarizeChunk / combineSummaries that indexing calls,
// so what you measure here is what the pipeline produces. Swap SUMMARIZE_MODEL
// to compare models on identical input.
//
//   pnpm run summarize:transcript -- <file> [--out summary.txt] [--verbose]
//
// Input formats (auto-detected):
//   .json   array of {role, content_text}
//   .jsonl  one {role, content_text} per line
//   .txt    raw text, treated as a single user message
//
// Dump a real session to compare against production:
//   docker exec mindmeld-postgres psql -U mindmeld -d conversations -tAc \
//     "SELECT json_agg(json_build_object('role', role, 'content_text', content_text)
//        ORDER BY sequence_num) FROM messages
//      WHERE session_id = 123 AND content_text IS NOT NULL AND LENGTH(content_text) > 0" \
//     > transcript.json
// MUST be first: config.ts reads process.env at module load, and only
// src/index.ts loads dotenv. Without this the CLI silently ignores .env and runs
// on the code defaults (qwen3:8b, a 120s timeout) instead of your configuration.
import "dotenv/config"
import { readFileSync, writeFileSync } from "node:fs"
import { buildChunkTexts, type SessionMessage } from "../src/embeddings/chunks.js"
import { combineSummaries, summarizeChunk, SUMMARIZE_MODEL } from "../src/embeddings/summarize.js"

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith("--"))
const verbose = args.includes("--verbose")
const outIndex = args.indexOf("--out")
const out = outIndex === -1 ? null : args[outIndex + 1]

if (!file) {
  console.error("usage: summarize-transcript.ts <file.json|.jsonl|.txt> [--out summary.txt] [--verbose]")
  process.exit(2)
}

const raw = readFileSync(file, "utf8")

const parse = (): SessionMessage[] => {
  if (file.endsWith(".jsonl"))
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l, i) => ({ id: i, ...JSON.parse(l) }))
  if (file.endsWith(".json"))
    return JSON.parse(raw).map((m: Omit<SessionMessage, "id">, i: number) => ({ id: i, ...m }))
  return [{ id: 0, role: "user", content_text: raw }]
}

const messages = parse().filter((m) => m.content_text && m.content_text.length > 0)
const chunks = buildChunkTexts(messages)

const log = (s: string) => verbose && console.error(s)
log(`model=${SUMMARIZE_MODEL} messages=${messages.length} chunks=${chunks.length}`)

const summaries: string[] = []
for (const [i, text] of chunks.entries()) {
  const t0 = performance.now()
  const summary = await summarizeChunk(text, chunks.length > 1)
  log(`chunk ${i + 1}/${chunks.length}: in ${text.length} chars, out ${summary.length}, ${((performance.now() - t0) / 1000).toFixed(1)}s`)
  summaries.push(summary)
}

// One chunk means no combine step — the chunk summary IS the session summary,
// exactly as batch.ts treats it.
const final = summaries.length > 1 ? await combineSummaries(summaries) : summaries[0]

if (out) writeFileSync(out, `${final.trim()}\n`)
console.log(final.trim())
process.exit(0)
