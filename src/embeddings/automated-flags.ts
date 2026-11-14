import { query } from '../db/postgres.js'
import { isAutomated } from './classify.js'
import { MEMORY_EXTERNAL_ID_LIKE } from '../sync/memory-id.js'

type Run = Pick<typeof import('../db/postgres.js'), 'query'>['query']

// A live session whose stored is_automated is the opposite of what
// classifyAutomated says about its opening line today.
export type FlagDrift = {
  id: number
  source: string
  machine: string | null
  stored: boolean
}

// Sources synced through syncSession in src/sync/claude-code.ts.
const TRANSCRIPT_SOURCES = ['claude_code', 'codex']

// The text a session is classified by, for every writer: the only statement of
// that rule (#177). Writers flag through flagAutomated once their messages
// land, and drift is measured against the same rows, so the two cannot differ.
//
// - A transcript is judged by its first user message, even an empty one: it
//   carries no title since #95, and a later user message can be a tool result
//   quoting a persona prompt. A transcript with no user message is not
//   automated.
// - A memory backup shares the claude_code source but is judged by its title,
//   the memory's name: its messages are versions of the file, not a prompt.
// - Every other source is judged by its title, which names the thread.
const openings = async (run: Run, ids?: readonly number[]) =>
  (
    await run<FlagDrift & { opening: string | null }>(
      `SELECT s.id, src.name AS source, p.machine AS machine, s.is_automated AS stored,
              split_part(CASE WHEN kind.transcript THEN m.content_text ELSE s.title END, E'\\n', 1) AS opening
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       JOIN sources src ON src.id = p.source_id
       CROSS JOIN LATERAL (
         SELECT src.name = ANY($2::text[]) AND s.external_id NOT LIKE $3 AS transcript
       ) kind
       LEFT JOIN LATERAL (
         SELECT content_text FROM messages
         WHERE kind.transcript AND session_id = s.id AND role = 'user'
         ORDER BY sequence_num NULLS FIRST, timestamp, id
         LIMIT 1
       ) m ON true
       WHERE s.deleted_at IS NULL AND ($1::int[] IS NULL OR s.id = ANY($1::int[]))`,
      [ids ?? null, TRANSCRIPT_SOURCES, MEMORY_EXTERNAL_ID_LIKE]
    )
  ).rows

const drifted = (rows: Awaited<ReturnType<typeof openings>>): FlagDrift[] =>
  rows
    .filter((row) => isAutomated(row.opening) !== row.stored)
    .map(({ id, source, machine, stored }) => ({ id, source, machine, stored }))

// Sessions whose stored flag the classifier contradicts, in both directions.
// `stored: false` should be flagged; `stored: true` is flagged by something
// this process's rule does not explain. Both are 0 on a healthy index.
export const findAutomatedDrift = async (): Promise<FlagDrift[]> => drifted(await openings(query))

// Flags the given sessions, or every live session, that the classifier marks
// automated. It never clears one. Every worker runs this with its own
// environment, so a worker missing MINDMELD_AUTOMATED_PREFIXES must not be able
// to undo what a configured one set: clearing is correctAutomatedDrift's job,
// run on purpose by scripts/backfill-automated.ts.
export const flagAutomated = async (ids?: readonly number[], run: Run = query): Promise<number> => {
  const missing = drifted(await openings(run, ids)).filter((d) => !d.stored)
  if (missing.length === 0) return 0
  const result = await run(`UPDATE sessions SET is_automated = true WHERE id = ANY($1::int[]) AND NOT is_automated`, [
    missing.map((d) => d.id),
  ])
  return result.rowCount ?? 0
}

// Sets each drifted flag to what the classifier says, in one statement. A row
// whose flag changed since it was read keeps its new value.
export const correctAutomatedDrift = async (drift: readonly FlagDrift[]): Promise<number> => {
  if (drift.length === 0) return 0
  const result = await query(
    `UPDATE sessions s SET is_automated = NOT d.stored
     FROM unnest($1::int[], $2::boolean[]) AS d(id, stored)
     WHERE s.id = d.id AND s.is_automated = d.stored`,
    [drift.map((d) => d.id), drift.map((d) => d.stored)]
  )
  return result.rowCount ?? 0
}
