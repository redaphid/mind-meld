import { config } from '../config.js'
import { query } from '../db/postgres.js'
import { getAllEmbeddings, upsertEmbeddings, deleteEmbeddings } from '../db/chroma.js'
import { generateEmbedding } from '../embeddings/ollama.js'
import { cosineSimilarity, normalizeVector } from '../utils/vector-math.js'

// NEGATIVE-VECTOR RANKING (task 326).
//
// Tagging a session "useless" hides that ONE session. This module is the other
// half: it learns what the reported sessions look like, so that sessions nobody
// has got round to reporting -- but which are the same KIND of noise -- rank
// lower too. Without it, every piece of noise has to be reported individually
// and search never gets ahead of the person feeding it.
//
// Three decisions here are deliberate, and each one rules out a plausible
// alternative:
//
// 1. NOISE VECTORS LIVE IN THEIR OWN CHROMA COLLECTION, AND SEARCH NEVER
//    QUERIES IT. Reported sessions are read only to build the penalty. A
//    "hidden" flag on rows inside a searchable collection would have needed
//    every arm to remember to filter it; a separate collection cannot be
//    forgotten.
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

const noiseId = (sessionId: number) => `noise-session-${sessionId}`

// The text that represents a session for noise purposes.
//
// Prefer the summary: it is what the sessions collection itself indexes, so a
// noise vector lands in the same neighbourhood as the session vectors it has to
// be compared against. The title is included because for notification stubs the
// title (of the form "<app package> - <N new likes>") carries nearly all of the
// signal and the body carries almost none.
export const noiseTextFor = (row: { title: string | null; summary: string | null }): string =>
  [row.title, row.summary].filter(Boolean).join('\n').trim()

type SessionVectorRow = { title: string | null; summary: string | null; centroid_vector: string | null }

// The vector to store for a reported session.
//
// centroid_vector when it exists, because it is already computed and is the
// session's own centre of mass. When it does not, embed title+summary rather
// than giving up: of six sessions observed polluting a live search, FIVE had no
// centroid_vector and ALL six had a summary. Skipping the centroid-less ones
// would have excluded the most representative noise in the corpus from the
// corpus.
export const resolveNoiseVector = async (sessionId: number): Promise<number[] | null> => {
  const result = await query<SessionVectorRow>(
    'SELECT title, summary, centroid_vector FROM sessions WHERE id = $1',
    [sessionId]
  )
  const row = result.rows[0]
  if (!row) return null

  if (row.centroid_vector) {
    try {
      const parsed = JSON.parse(row.centroid_vector)
      if (Array.isArray(parsed) && parsed.length > 0) return normalizeVector(parsed)
    } catch {
      // A corrupt centroid is not a reason to refuse the report. Fall through
      // and embed the text instead.
    }
  }

  const text = noiseTextFor(row)
  if (!text) return null
  return normalizeVector(await generateEmbedding(text))
}

// Add a session to the noise corpus. Upsert, so re-reporting a session that was
// already reported is a no-op rather than a duplicate vector that would quietly
// give that one session double weight in clustering.
export const recordNoiseVector = async (sessionId: number): Promise<boolean> => {
  const vector = await resolveNoiseVector(sessionId)
  if (!vector) return false
  await upsertEmbeddings(config.chroma.collections.noise, {
    ids: [noiseId(sessionId)],
    embeddings: [vector],
    // No session text is stored. The vector is all the penalty needs, and the
    // noise corpus is disproportionately personal-notification content -- there
    // is no reason to keep a second plaintext copy of it in another store.
    documents: [''],
    metadatas: [{ session_id: sessionId }],
  })
  invalidateNoiseClusters()
  return true
}

// Take a session back out of the noise corpus. Un-reporting has to undo BOTH
// halves -- the tag and the vector -- or an un-reported session would carry on
// teaching search to demote everything that looks like it.
export const forgetNoiseVector = async (sessionId: number): Promise<void> => {
  await deleteEmbeddings(config.chroma.collections.noise, [noiseId(sessionId)])
  invalidateNoiseClusters()
}

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
// Deterministic: the seeded PRNG means the same corpus produces the same
// centroids in every process, which is what makes the behaviour testable and a
// ranking change explainable rather than mysterious.
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

type ClusterCache = { centroids: number[][]; computedAt: number; size: number }
let cache: ClusterCache | null = null

export const invalidateNoiseClusters = (): void => {
  cache = null
}

// The current noise cluster centroids, rebuilt at most once per cache window.
//
// Returns an empty array when nothing has been reported, and every caller reads
// that as "no penalty" rather than as an error -- on a fresh install the noise
// corpus is empty, and search has to behave exactly as it did before any of
// this existed.
export const getNoiseClusters = async (now = Date.now()): Promise<number[][]> => {
  if (cache && now - cache.computedAt < config.noise.clusterCacheMs) return cache.centroids

  let centroids: number[][] = []
  let size = 0
  try {
    const { embeddings } = await getAllEmbeddings(config.chroma.collections.noise)
    size = embeddings.length
    if (size > 0) {
      const normalized = embeddings.map((v) => normalizeVector(v))
      centroids = sphericalKMeans(normalized, chooseClusterCount(size))
    }
  } catch (e) {
    // A missing or unreachable noise collection has to degrade to "no penalty",
    // never to a failed search. Ranking help is an enhancement; retrieval is
    // the product.
    console.error('Noise clusters unavailable, ranking penalty disabled for this search:', e)
    centroids = []
  }

  cache = { centroids, computedAt: now, size }
  return centroids
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

  let nearest = -Infinity
  for (const centroid of clusters) {
    const similarity = cosineSimilarity(vector, centroid)
    if (similarity > nearest) nearest = similarity
  }

  if (!Number.isFinite(nearest) || nearest <= floor) return 1
  const headroom = 1 - floor
  const excess = headroom > 0 ? (nearest - floor) / headroom : 1
  return Math.max(0, 1 - weight * Math.min(1, excess))
}
