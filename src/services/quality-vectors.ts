/**
 * Quality direction vectors -- the machinery that lets a judgement you recorded
 * on one session steer search away from thousands you never looked at.
 *
 * The `useless` tag already HIDES what you labelled (it is in
 * config.tags.defaultExcluded). This module is about the sessions you did NOT
 * label: it learns the direction in embedding space that your labelled examples
 * share, so an unlabelled session pointing the same way can be demoted.
 *
 * Read init-db/024-quality-vectors.sql before changing any of this. The short
 * version: comparisons here are meaningless until the corpus-wide common
 * direction is subtracted, and `cohesion` is meaningless without `baseline`.
 */

import { query } from '../db/postgres.js'
import { centerVector, magnitude, meanVector, normalizeVector, cosineSimilarity } from '../utils/vector-math.js'
import { notWarmup } from '../mcp/title.js'

export const GLOBAL_MEAN_VECTOR = 'global_mean'
export const USELESS_VECTOR = 'useless'

/**
 * Below this many labelled examples, the mean is dominated by whichever handful
 * you happened to tag rather than by anything they have in common.
 */
export const MIN_MEMBER_COUNT = 20

/**
 * A labelled set must be at least this many times tighter than an equal-size
 * random sample to be treated as signal. 2x is deliberately not marginal: at
 * the measured 0.5136 vs 0.1649 the real ratio is ~3.1x, so this trips on a
 * genuine collapse rather than on ordinary drift.
 */
export const MIN_COHESION_RATIO = 2

export type QualityVector = {
  name: string
  vector: number[]
  memberCount: number
  cohesion: number
  baseline: number
  computedAt: Date
}

type CentroidRow = { id: number; centroid_vector: string }

const parseCentroids = (rows: CentroidRow[], dims: number): number[][] => {
  const out: number[][] = []
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.centroid_vector)
    } catch {
      throw new Error(`Session ${row.id} has an unparseable centroid_vector`)
    }
    // Throw rather than skip. The previous code in compute-centroids.ts skipped
    // wrong-length vectors silently, which turns a dimension change into empty
    // output with no error -- a measurement that never ran, reported as zero.
    if (!Array.isArray(parsed) || parsed.length !== dims) {
      throw new Error(
        `Session ${row.id} centroid has ${Array.isArray(parsed) ? parsed.length : 'non-array'} dimensions, expected ${dims}`
      )
    }
    out.push(parsed as number[])
  }
  return out
}

/** Live, non-warmup sessions that have a centroid. The population everything else is relative to. */
const LIVE_SESSIONS = `s.centroid_vector IS NOT NULL AND s.deleted_at IS NULL AND ${notWarmup('s')}`

export const loadAllSessionCentroids = async (dims: number): Promise<number[][]> => {
  const result = await query<CentroidRow>(
    `SELECT s.id, s.centroid_vector FROM sessions s WHERE ${LIVE_SESSIONS}`
  )
  return parseCentroids(result.rows, dims)
}

export const loadTaggedSessionCentroids = async (tag: string, dims: number): Promise<number[][]> => {
  const result = await query<CentroidRow>(
    `SELECT DISTINCT s.id, s.centroid_vector
       FROM sessions s
       JOIN tags t ON t.session_id = s.id
      WHERE t.tag = $1 AND ${LIVE_SESSIONS}`,
    [tag]
  )
  return parseCentroids(result.rows, dims)
}

/**
 * Centroids of sessions carrying NO quality tag, sampled at random -- the
 * control group. Excluding tagged sessions matters: leaving them in would make
 * the baseline creep toward the thing it is supposed to be a null hypothesis
 * for, and the guardrail would loosen exactly as the signal decayed.
 */
export const loadRandomSessionCentroids = async (
  count: number,
  excludeTags: string[],
  dims: number
): Promise<number[][]> => {
  const result = await query<CentroidRow>(
    `SELECT s.id, s.centroid_vector
       FROM sessions s
      WHERE ${LIVE_SESSIONS}
        AND NOT EXISTS (
          SELECT 1 FROM tags t WHERE t.session_id = s.id AND t.tag = ANY($1::text[])
        )
      ORDER BY random()
      LIMIT $2`,
    [excludeTags, count]
  )
  return parseCentroids(result.rows, dims)
}

/**
 * Centroids for a specific set of sessions, for scoring search candidates.
 *
 * Batched deliberately, mirroring getSessionTags: a candidate set is typically
 * ~8x the page size, and one query over an id array costs far less than
 * hydrating a 1024-float column through every arm's row type.
 *
 * Sessions with no centroid are simply absent from the map -- a session too new
 * or too short to have one must not be penalized for it.
 */
export const loadSessionCentroidsByIds = async (ids: number[]): Promise<Map<number, number[]>> => {
  const out = new Map<number, number[]>()
  if (ids.length === 0) return out
  const result = await query<CentroidRow>(
    `SELECT s.id, s.centroid_vector FROM sessions s
      WHERE s.id = ANY($1::int[]) AND s.centroid_vector IS NOT NULL`,
    [ids]
  )
  for (const row of result.rows) {
    try {
      const parsed = JSON.parse(row.centroid_vector) as unknown
      if (Array.isArray(parsed)) out.set(row.id, parsed as number[])
    } catch {
      // A single corrupt centroid must not fail a search. It costs this one
      // session its penalty, which is the safe direction: it ranks as it did
      // before the feature existed.
    }
  }
  return out
}

/**
 * The corpus's centre of mass: the mean of every live session's unit centroid.
 * This is the anisotropy that has to come off before any similarity here means
 * what it says.
 */
export const computeGlobalMean = (centroids: number[][]): number[] =>
  meanVector(centroids.map(normalizeVector))

/**
 * Build a direction from labelled examples.
 *
 * Returns the unit direction plus the two numbers that say whether it should be
 * believed: `cohesion` (how much the members agree) and `baseline` (how much an
 * equal-size random sample agrees, which is never zero).
 */
export const computeDirection = (
  members: number[][],
  control: number[][],
  globalMean: number[]
): { vector: number[]; cohesion: number; baseline: number } => {
  const centered = members.map((v) => centerVector(v, globalMean))
  const mean = meanVector(centered)
  return {
    vector: normalizeVector(mean),
    cohesion: magnitude(mean),
    baseline: control.length > 0 ? magnitude(meanVector(control.map((v) => centerVector(v, globalMean)))) : 0,
  }
}

const upsert = async (
  name: string,
  vector: number[],
  memberCount: number,
  cohesion: number,
  baseline: number
): Promise<void> => {
  await query(
    `INSERT INTO quality_vectors (name, vector, member_count, cohesion, baseline, computed_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (name) DO UPDATE
       SET vector = EXCLUDED.vector,
           member_count = EXCLUDED.member_count,
           cohesion = EXCLUDED.cohesion,
           baseline = EXCLUDED.baseline,
           computed_at = EXCLUDED.computed_at`,
    [name, JSON.stringify(vector), memberCount, cohesion, baseline]
  )
}

/**
 * Recompute and store both vectors. Always writes them together: `useless` is
 * expressed in a basis defined by `global_mean`, so a half-refresh leaves the
 * two disagreeing about where the origin is, with no symptom.
 */
export const refreshQualityVectors = async (
  dims: number
): Promise<{ globalMeanMembers: number; useless: { cohesion: number; baseline: number; memberCount: number } | null }> => {
  const all = await loadAllSessionCentroids(dims)
  if (all.length === 0) {
    console.warn('quality-vectors: no session centroids found; run compute:centroids first')
    return { globalMeanMembers: 0, useless: null }
  }

  const globalMean = computeGlobalMean(all)
  // member_count is the corpus size; cohesion/baseline are not meaningful for
  // the global mean itself (it IS the thing others are measured against), so
  // they are stored as its own magnitude and 0.
  await upsert(GLOBAL_MEAN_VECTOR, globalMean, all.length, magnitude(globalMean), 0)

  const members = await loadTaggedSessionCentroids(USELESS_VECTOR, dims)
  if (members.length === 0) {
    console.warn(`quality-vectors: no sessions tagged "${USELESS_VECTOR}"; nothing to learn from`)
    return { globalMeanMembers: all.length, useless: null }
  }

  const control = await loadRandomSessionCentroids(members.length, [USELESS_VECTOR], dims)
  const { vector, cohesion, baseline } = computeDirection(members, control, globalMean)
  await upsert(USELESS_VECTOR, vector, members.length, cohesion, baseline)

  console.log(
    `quality-vectors: ${USELESS_VECTOR} from ${members.length} sessions -- ` +
      `cohesion ${cohesion.toFixed(4)} vs baseline ${baseline.toFixed(4)} ` +
      `(${(cohesion / (baseline || 1)).toFixed(1)}x)`
  )
  return { globalMeanMembers: all.length, useless: { cohesion, baseline, memberCount: members.length } }
}

export const loadQualityVector = async (name: string): Promise<QualityVector | null> => {
  const result = await query<{
    name: string
    vector: string
    member_count: number
    cohesion: number
    baseline: number
    computed_at: Date
  }>(`SELECT name, vector, member_count, cohesion, baseline, computed_at FROM quality_vectors WHERE name = $1`, [name])
  const row = result.rows[0]
  if (!row) return null
  return {
    name: row.name,
    vector: JSON.parse(row.vector) as number[],
    memberCount: row.member_count,
    cohesion: row.cohesion,
    baseline: row.baseline,
    computedAt: row.computed_at,
  }
}

/**
 * Whether a direction is trustworthy enough to change someone's search results.
 * Returns a reason when it is not, so the caller can SAY so rather than quietly
 * ranking by noise.
 */
export const directionUsability = (v: QualityVector | null): { usable: boolean; reason?: string } => {
  if (!v) return { usable: false, reason: 'no quality vector computed yet (run compute:centroids)' }
  if (v.memberCount < MIN_MEMBER_COUNT)
    return { usable: false, reason: `only ${v.memberCount} labelled sessions, need ${MIN_MEMBER_COUNT}` }
  if (v.cohesion < MIN_COHESION_RATIO * v.baseline)
    return {
      usable: false,
      reason: `labelled sessions are no tighter than chance (cohesion ${v.cohesion.toFixed(3)} vs baseline ${v.baseline.toFixed(3)})`,
    }
  return { usable: true }
}

/**
 * The per-result penalty multiplier.
 *
 * `max(0, sim)` is load-bearing: unlabelled sessions average slightly NEGATIVE
 * against the useless direction, so passing raw similarity through would hand
 * roughly half the corpus a free promotion -- noise wearing the costume of a
 * quality signal. Only demote; never reward.
 */
export const qualityMultiplier = (
  sessionCentroid: number[],
  direction: number[],
  globalMean: number[],
  beta: number
): number => {
  if (beta <= 0) return 1
  const sim = cosineSimilarity(centerVector(sessionCentroid, globalMean), direction)
  return 1 - beta * Math.max(0, sim)
}
