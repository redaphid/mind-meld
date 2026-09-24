import { config } from '../config.js'
import { query } from '../db/postgres.js'
import { getEmbeddingsByIds, hasId } from '../db/chroma.js'
import { sessionVectorId } from '../db/vector-ids.js'
import { cosineSimilarity, normalizeVector } from '../utils/vector-math.js'

// NEGATIVE-VECTOR RANKING (task 326).
//
// Tagging a session "useless" hides that ONE session. This module is the other
// half: it learns what noise looks like, so that sessions nobody has got round
// to reporting -- but which are the same KIND of noise -- rank lower too.
// Without it, every piece of noise has to be reported individually and search
// never gets ahead of the person feeding it.
//
// Three decisions here are deliberate, and each one rules out a plausible
// alternative:
//
// 1. THE CORPUS IS DERIVED, NEVER STORED. A session is noise when sync flagged
//    it automated or an agent tagged it "useless" -- two facts Postgres already
//    holds -- and its vector is the session summary vector search itself
//    retrieves by. A separate store of copied vectors needed a write on every
//    report and a matching delete on every undo, drifted whenever one half
//    failed, and never learned from the automated flag at all.
//
// 2. THE CENTROIDS ARE CLUSTERED, NOT AVERAGED. Sentinel notifications and
//    tool-call spam sit in different regions of embedding space. Their global
//    mean is a point in the empty space between them: it resembles neither, so
//    it demotes neither, while still sitting close enough to unrelated text to
//    cost real results. Nearest-cluster similarity is the whole mechanism.
//
// 3. THE PENALTY IS APPLIED AT RANKING TIME, NOT TO THE QUERY. Subtracting a
//    noise centroid from the query vector (Rocchio-style) moves the query
//    somewhere nobody asked about and retrieves a different, unrelated
//    neighbourhood. Ranking down what came back leaves retrieval honest.
//    Measured rather than assumed -- see the sweep recorded in the PR.
//
// `pnpm run noise:eval` measures all of this against the live index.

export const USELESS_TAG = 'useless'

// Whether a session has a summary vector to teach the penalty with. A session
// reported before it was summarized joins the corpus once it is.
export const hasNoiseVector = (sessionId: number): Promise<boolean> =>
  hasId(config.chroma.collections.sessions, sessionVectorId(sessionId))

// How many clusters for a corpus of n vectors: about one per four, capped.
//
// This started as sqrt(n/2), the usual rule of thumb, which gives k=8 for the
// 120-vector corpus the tuning sweep ran against. The sweep then showed that
// COLLATERAL DAMAGE FALLS AS k RISES, near-monotonically, while the amount the
// noise itself moves stays roughly flat:
//
//   k    mean rank change: held-out noise / real DM threads / real SMS
//   1     +1.57   +0.35   +0.15     <- one global centroid
//   2     +1.70   +0.35   +0.20
//   4     +1.07   +0.18   +0.13
//   8     +1.07   +0.12   +0.23
//   16    +1.61   +0.18   +0.15
//   32    +1.86   +0.00   +0.20
//
// That trend is the clustering argument carried to its conclusion rather than a
// lucky point: a finer model resembles SPECIFIC noise more and generic text
// less, so it charges real conversations less. At k=32 the DM threads were left
// exactly where the unpenalized run put them.
//
// So the target is ~4 vectors per cluster. The cap is what stops a large corpus
// from costing a comparison per cluster on every hit, and the floor of 1 keeps
// a corpus of two or three from degenerating into exact-match blocking.
export const chooseClusterCount = (n: number, configured = config.noise.clusterCount): number => {
  if (n <= 0) return 0
  if (configured > 0) return Math.max(1, Math.min(configured, n))
  return Math.max(1, Math.min(32, Math.round(n / 4)))
}

// Spherical k-means: L2-normalized vectors and centroids, assignment by maximum
// cosine similarity. Plain Euclidean k-means is the wrong tool here -- the
// retrieval space is cosine, so clusters have to be defined by angle rather
// than by magnitude, or the centroids describe a geometry search does not use.
//
// Deterministic: the seeded PRNG means the same corpus IN THE SAME ORDER produces
// the same centroids in every process, which is what makes the behaviour
// testable and a ranking change explainable rather than mysterious. The seed
// picks centres by position, so loadNoiseCorpus fixes the order: without it,
// writing one tag could reshuffle Postgres' row order and every cluster with it.
export const sphericalKMeans = (
  vectors: readonly number[][],
  k: number,
  iterations = 25,
  seed = 20260826
): number[][] => {
  if (vectors.length === 0 || k <= 0) return []
  if (k >= vectors.length) return vectors.map((v) => normalizeVector([...v]))

  // mulberry32 -- small, seeded, dependency-free.
  let state = seed >>> 0
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  // k-means++ style spread: the first centre at random, then each subsequent
  // centre is the vector furthest (in cosine terms) from every centre chosen so
  // far. Purely random initialisation on a corpus this lopsided routinely put
  // two centres inside the same dense blob and left a whole noise region
  // unmodelled.
  const centroids: number[][] = [normalizeVector([...vectors[Math.floor(random() * vectors.length)]])]
  while (centroids.length < k) {
    let worstIndex = 0
    let worstSimilarity = Infinity
    vectors.forEach((v, i) => {
      let best = -Infinity
      for (const c of centroids) {
        const similarity = cosineSimilarity(v, c)
        if (similarity > best) best = similarity
      }
      if (best < worstSimilarity) {
        worstSimilarity = best
        worstIndex = i
      }
    })
    centroids.push(normalizeVector([...vectors[worstIndex]]))
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    const sums = centroids.map(() => new Array<number>(vectors[0].length).fill(0))
    const counts = centroids.map(() => 0)

    for (const v of vectors) {
      let best = 0
      let bestSimilarity = -Infinity
      for (let c = 0; c < centroids.length; c++) {
        const similarity = cosineSimilarity(v, centroids[c])
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity
          best = c
        }
      }
      counts[best]++
      for (let d = 0; d < v.length; d++) sums[best][d] += v[d]
    }

    let moved = false
    for (let c = 0; c < centroids.length; c++) {
      // An empty cluster keeps its previous centre rather than being re-seeded
      // at random: re-seeding would make the result depend on the iteration
      // count, undoing the determinism the seed exists to provide.
      if (counts[c] === 0) continue
      const next = normalizeVector(sums[c].map((x) => x / counts[c]))
      if (!moved && cosineSimilarity(next, centroids[c]) < 0.999999) moved = true
      centroids[c] = next
    }
    if (!moved) break
  }

  return centroids
}

// Where a session's noise verdict came from. Sync flags automated runs by the
// thousand; agents report sessions a handful at a time.
type NoiseSource = 'automated' | 'reported'

export type NoiseVector = { sessionId: number; vector: number[]; source: NoiseSource }

// Every vector the penalty learns from, keyed by the session it came from. The
// eval harness (scripts/noise-eval.ts) reads the corpus through this too, so
// what it measures is what search clusters.
// The vector a session is judged by, on both sides of the penalty: the corpus
// is built from noise sessions' summary vectors and every search hit is scored
// by its own. Comparing a message or chunk vector against summary vectors put
// the two in different distributions, and a full-text hit had no vector at all.
export const sessionVectors = async (sessionIds: number[]): Promise<Map<number, number[]>> => {
  const byId = await getEmbeddingsByIds(config.chroma.collections.sessions, sessionIds.map(sessionVectorId))
  return new Map(sessionIds.flatMap((id) => {
    const vector = byId.get(sessionVectorId(id))
    return vector ? [[id, normalizeVector(vector)] as const] : []
  }))
}

export const loadNoiseCorpus = async (): Promise<NoiseVector[]> => {
  const { rows } = await query<{ id: number; is_automated: boolean }>(
    `SELECT s.id, s.is_automated FROM sessions s
     WHERE s.deleted_at IS NULL
       AND (s.is_automated OR EXISTS (SELECT 1 FROM tags t WHERE t.session_id = s.id AND t.tag = $1))
     ORDER BY s.id`,
    [USELESS_TAG]
  )
  const vectors = await sessionVectors(rows.map((r) => r.id))
  return rows.flatMap(({ id, is_automated }) => {
    const vector = vectors.get(id)
    return vector ? [{ sessionId: id, vector, source: is_automated ? ('automated' as const) : ('reported' as const) }] : []
  })
}

// Each source is clustered on its own, and their clusters pooled. Clustered
// together, a few fresh reports are outvoted by thousands of automated runs:
// k-means re-seats every centre, the reports rarely get one of their own, and
// some lookalikes end up LESS noise-like after a report than before it. Apart,
// adding reports never moves an automated cluster, and a handful of reports of
// a new kind of noise gets a centre of its own straight away. Measured on the
// live index: reporting 5 of a 1,718-session family moved 88% of the rest
// closer to the noise (median similarity 0.692 -> 0.812), against 86% and 0.764
// clustered jointly.
export const clusterNoise = (corpus: readonly NoiseVector[]): number[][] =>
  (['automated', 'reported'] as const).flatMap((source) => {
    const vectors = corpus.filter((c) => c.source === source).map((c) => c.vector)
    return sphericalKMeans(vectors, chooseClusterCount(vectors.length))
  })

type ClusterCache = { centroids: number[][]; computedAt: number; size: number }
let cache: ClusterCache | null = null

// Clustering ~2k vectors takes most of a second. Concurrent searches that miss
// the cache share one build instead of each running their own, and a report
// that lands mid-build bumps the generation so that build is not cached over it.
let building: Promise<number[][]> | null = null
let generation = 0

export const invalidateNoiseClusters = (): void => {
  cache = null
  building = null
  generation++
}

const buildClusters = async (now: number, startedAt: number): Promise<number[][]> => {
  let centroids: number[][] = []
  let size = 0
  try {
    const corpus = await loadNoiseCorpus()
    size = corpus.length
    centroids = clusterNoise(corpus)
  } catch (e) {
    // An unreadable corpus has to degrade to "no penalty", never to a failed
    // search. Ranking help is an enhancement; retrieval is the product.
    console.error('Noise clusters unavailable, ranking penalty disabled for this search:', e)
  }
  if (startedAt === generation) cache = { centroids, computedAt: now, size }
  return centroids
}

// The current noise cluster centroids, rebuilt at most once per cache window.
//
// Returns an empty array when nothing counts as noise, and every caller reads
// that as "no penalty" rather than as an error -- on a fresh install the noise
// corpus is empty, and search has to behave exactly as it did before any of
// this existed.
export const getNoiseClusters = async (now = Date.now()): Promise<number[][]> => {
  if (cache && now - cache.computedAt < config.noise.clusterCacheMs) return cache.centroids
  if (!building) {
    const startedAt = generation
    building = (async () => {
      try {
        return await buildClusters(now, startedAt)
      } finally {
        if (startedAt === generation) building = null
      }
    })()
  }
  return building
}

// Cosine similarity to the closest noise cluster; -Infinity with no clusters.
export const nearestSimilarity = (vector: number[], clusters: readonly number[][]): number => {
  let nearest = -Infinity
  for (const centroid of clusters) {
    const similarity = cosineSimilarity(vector, centroid)
    if (similarity > nearest) nearest = similarity
  }
  return nearest
}

// How much of a result's score survives its resemblance to noise.
//
// Returns a multiplier in [0, 1]; 1 means untouched. Multiplicative because the
// fused score is an RRF sum (~0.01-0.05) while PROJECT_BOOST is a flat 0.5 --
// any subtractive penalty tuned to matter against one is meaningless against
// the other.
//
// The floor is what makes this discriminative. bge-m3 scores unrelated text at
// around 0.4-0.5 cosine, so an unfloored penalty taxes EVERY result by roughly
// the same amount, changing no relative order while costing the computation.
// Only similarity above the floor is charged for, rescaled so a result sitting
// exactly on a noise cluster pays the full weight.
export const noiseDamping = (
  vector: number[] | null | undefined,
  clusters: readonly number[][],
  weight = config.noise.penaltyWeight,
  floor = config.noise.similarityFloor
): number => {
  if (!vector || vector.length === 0 || clusters.length === 0 || weight <= 0) return 1

  const nearest = nearestSimilarity(vector, clusters)
  if (!Number.isFinite(nearest) || nearest <= floor) return 1
  const headroom = 1 - floor
  const excess = headroom > 0 ? (nearest - floor) / headroom : 1
  return Math.max(0, 1 - weight * Math.min(1, excess))
}
