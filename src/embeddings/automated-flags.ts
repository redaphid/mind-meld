import { query } from '../db/postgres.js'
import { isAutomated } from './classify.js'

// Sources synced through syncSession in src/sync/claude-code.ts, which
// classifies a session by its first user message: they carry no title since
// #95. Every other writer classifies the title it writes.
const FIRST_PROMPT_SOURCES = ['claude_code', 'codex']

// A live session whose stored is_automated is the opposite of what
// classifyAutomated says about its opening line today.
export type FlagDrift = {
  id: number
  source: string
  machine: string | null
  stored: boolean
}

// is_automated is a cached reading of a session's opening line against the
// configured patterns, and sync rewrites it only when a transcript changes. So
// a pattern added later never reaches sessions whose files are done changing,
// and a flag set by anything but classifyAutomated is undone by the next
// re-sync (#177). Zero rows means every stored flag agrees.
export const findAutomatedDrift = async (): Promise<FlagDrift[]> => {
  const { rows } = await query<FlagDrift & { opening: string | null }>(
    `SELECT s.id, src.name AS source, COALESCE(s.machine, p.machine) AS machine, s.is_automated AS stored,
            split_part(CASE WHEN src.name = ANY($1::text[]) THEN m.content_text ELSE s.title END, E'\\n', 1) AS opening
     FROM sessions s
     JOIN projects p ON p.id = s.project_id
     JOIN sources src ON src.id = p.source_id
     LEFT JOIN LATERAL (
       SELECT content_text FROM messages
       WHERE src.name = ANY($1::text[]) AND session_id = s.id AND role = 'user'
       ORDER BY sequence_num NULLS FIRST, timestamp, id
       LIMIT 1
     ) m ON true
     WHERE s.deleted_at IS NULL`,
    [FIRST_PROMPT_SOURCES]
  )
  return rows
    .filter((row) => isAutomated(row.opening) !== row.stored)
    .map(({ id, source, machine, stored }) => ({ id, source, machine, stored }))
}

// One statement, so it lands whole or not at all. A row that changed since it
// was read keeps its new value: the write it lost to classified it too.
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
