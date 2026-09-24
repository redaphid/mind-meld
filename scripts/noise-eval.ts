/**
 * How well does the noise penalty separate reported noise from real sessions?
 *
 *   pnpm run noise:eval                         one JSON line on stdout
 *   pnpm run noise:eval -- --hard 123,456       also report these real sessions
 *   pnpm run noise:eval -- --dump out.json      also write every similarity
 *
 * Read-only. The corpus is whatever src/mcp/noise.ts loads; each held-out
 * noise session and each real session is scored by its session summary vector,
 * the vector a search result stands for. Every change to noise ranking should
 * ship with this output from before and after it.
 */
import 'dotenv/config'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { config } from '../src/config.js'
import { query, closePool } from '../src/db/postgres.js'
import { getEmbeddingsByIds } from '../src/db/chroma.js'
import { loadNoiseCorpus, sampleRealSessionIds } from '../src/mcp/noise.js'
import { evaluateNoise } from '../src/mcp/noise-eval.js'
import { resolveDataClasses } from '../src/mcp/search.js'
import { normalizeVector } from '../src/utils/vector-math.js'

const REAL_SAMPLE = 500
const dataClasses = resolveDataClasses({})
assert(dataClasses, 'a default search is expected to filter by data class')

// pnpm forwards its own `--` separator, which parseArgs would read as the end
// of the options.
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: { hard: { type: 'string' }, dump: { type: 'string' } },
})

const sessionVectors = async (sessionIds: number[]): Promise<Map<number, number[]>> => {
  const byId = await getEmbeddingsByIds(config.chroma.collections.sessions, sessionIds.map((id) => `session-${id}`))
  return new Map([...byId].map(([id, vector]) => [Number(id.replace('session-', '')), normalizeVector(vector)]))
}

// Summarized sessions a default search can return that nothing marks as noise,
// in a fixed pseudo-random order so reruns compare like with like.
const realSessionIds = async (): Promise<number[]> => {
  const result = await query<{ id: number }>(
    `SELECT s.id FROM sessions s
     JOIN projects p ON p.id = s.project_id
     JOIN sources src ON src.id = p.source_id
     WHERE s.deleted_at IS NULL AND s.summary IS NOT NULL AND NOT s.is_automated
       AND COALESCE(p.data_class, src.data_class) = ANY($2::text[])
       AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.session_id = s.id AND t.tag = 'useless')
     ORDER BY md5(s.id::text || 'noise-eval')
     LIMIT $1`,
    [REAL_SAMPLE * 2, dataClasses]
  )
  return result.rows.map((r) => r.id)
}

// Production calibrates the floor against its own sample of real sessions; the
// eval measures real sessions it did NOT calibrate on, or the damped share would
// come out at 1 - quantile by construction.
const calibrationIds = await sampleRealSessionIds(config.noise.floorSample)
const calibration = [...(await sessionVectors(calibrationIds)).values()]

const corpus = await loadNoiseCorpus()
const subjects = await sessionVectors(corpus.map((c) => c.sessionId))
const heldOutReal = (await realSessionIds()).filter((id) => !calibrationIds.includes(id))
const real = [...(await sessionVectors(heldOutReal)).values()].slice(0, REAL_SAMPLE)
const hardIds = values.hard ? values.hard.split(',').map(Number) : []
const hard = [...(await sessionVectors(hardIds))].map(([sessionId, vector]) => ({ sessionId, vector }))

const { noiseSimilarities, realSimilarities, realFoldSimilarities, ...report } = evaluateNoise({
  corpus,
  subjects,
  real,
  hard,
  weight: config.noise.penaltyWeight,
  calibration,
})

console.log(JSON.stringify(report))
// realFoldSimilarities is what the AUC compares noise against; realSimilarities
// is what search sees, against the full corpus.
if (values.dump)
  writeFileSync(values.dump, JSON.stringify({ report, noiseSimilarities, realSimilarities, realFoldSimilarities }))
await closePool()
