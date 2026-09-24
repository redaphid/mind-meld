import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] as unknown[], rowCount: 0 }))
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => query(...(args as [])),
}))

const getEmbeddingsByIds = vi.fn(async (..._args: unknown[]) => new Map<string, number[]>())
const hasId = vi.fn(async (..._args: unknown[]) => true)
vi.mock('../db/chroma.js', () => ({
  getEmbeddingsByIds: (...args: unknown[]) => getEmbeddingsByIds(...(args as [])),
  hasId: (...args: unknown[]) => hasId(...(args as [])),
}))

const mockConfig = {
  chroma: { collections: { sessions: 'convo-sessions' } },
  noise: { penaltyWeight: 0.35, floorQuantile: 0.95, floorSample: 500, clusterCount: 0, clusterCacheMs: 300000 },
}
vi.mock('../config.js', () => ({ config: mockConfig }))

const {
  USELESS_TAG,
  hasNoiseVector,
  loadNoiseCorpus,
  chooseClusterCount,
  sphericalKMeans,
  getNoiseModel,
  calibrateFloor,
  sampleRealSessionIds,
  quantile,
  invalidateNoiseClusters,
  noiseDamping,
  buildNoiseModel,
} = await import('./noise.js')
const { normalizeVector } = await import('../utils/vector-math.js')

// A unit vector pointing along one axis of a small space, so "different region
// of embedding space" is something a reader can see rather than infer.
const axis = (i: number, dims = 8): number[] => Array.from({ length: dims }, (_, d) => (d === i ? 1 : 0))

// A vector `t` of the way from a towards b, renormalized. Used to place a probe
// deliberately between two noise regions.
const between = (a: number[], b: number[], t: number): number[] => a.map((x, i) => x * (1 - t) + b[i] * t)

// Clusters with a floor, the way search receives them.
const at = (centroids: number[][], floor = 0.55) => ({ centroids, floor })

beforeEach(() => {
  vi.clearAllMocks()
  mockConfig.noise = { penaltyWeight: 0.35, floorQuantile: 0.95, floorSample: 500, clusterCount: 0, clusterCacheMs: 300000 }
  query.mockResolvedValue({ rows: [], rowCount: 0 })
  getEmbeddingsByIds.mockResolvedValue(new Map())
  invalidateNoiseClusters()
})

describe('choosing a cluster count', () => {
  it('has no clusters for an empty corpus', () => {
    expect(chooseClusterCount(0)).toBe(0)
  })

  it('scales with the corpus rather than being fixed', () => {
    // ~4 vectors per cluster. A handful of reported sessions must not become a
    // dozen "clusters" of one, and a large corpus must not be squashed into a
    // single mean -- the tuning sweep showed collateral damage falling as k
    // rises, so the heuristic leans toward more clusters rather than fewer.
    expect(chooseClusterCount(2)).toBe(1)
    expect(chooseClusterCount(50)).toBe(13)
    expect(chooseClusterCount(120)).toBe(30)
  })

  it('caps k so a big corpus does not cost a comparison per cluster forever', () => {
    expect(chooseClusterCount(100000)).toBe(32)
  })

  it('never asks for more clusters than there are vectors', () => {
    expect(chooseClusterCount(3, 99)).toBe(3)
  })

  it('lets configuration override the heuristic', () => {
    expect(chooseClusterCount(200, 4)).toBe(4)
  })
})

describe('spherical k-means', () => {
  it('finds the two regions in a corpus that has two', () => {
    const groupA = [axis(0), between(axis(0), axis(1), 0.1), between(axis(0), axis(1), 0.05)]
    const groupB = [axis(4), between(axis(4), axis(5), 0.1), between(axis(4), axis(5), 0.05)]
    const centroids = sphericalKMeans([...groupA, ...groupB], 2)

    expect(centroids).toHaveLength(2)
    // One centroid sits in each region, and neither sits between them.
    const nearA = centroids.filter((c) => c[0] > 0.9)
    const nearB = centroids.filter((c) => c[4] > 0.9)
    expect(nearA).toHaveLength(1)
    expect(nearB).toHaveLength(1)
  })

  it('is deterministic, so a ranking change is explainable', () => {
    const corpus = [axis(0), axis(1), axis(2), axis(3), axis(4), axis(5)]
    expect(sphericalKMeans(corpus, 3)).toEqual(sphericalKMeans(corpus, 3))
  })

  it('returns the corpus itself when asked for more clusters than vectors', () => {
    const centroids = sphericalKMeans([axis(0), axis(1)], 5)
    expect(centroids).toHaveLength(2)
  })

  it('has nothing to say about an empty corpus', () => {
    expect(sphericalKMeans([], 3)).toEqual([])
  })
})

describe('the noise damping factor', () => {
  const clusters = [axis(0), axis(4)]

  it('leaves a result untouched when nothing has been reported', () => {
    expect(noiseDamping(axis(0), at([]))).toBe(1)
  })

  it('leaves a result untouched when it has no vector', () => {
    // Full-text-only hits have no embedding and must not be penalized on a guess.
    expect(noiseDamping(null, at(clusters))).toBe(1)
  })

  it('charges nothing below the similarity floor', () => {
    // Orthogonal to every cluster: as unlike the noise as this space allows.
    expect(noiseDamping(axis(7), at(clusters))).toBe(1)
  })

  it('charges the full weight for a result sitting on a noise cluster', () => {
    expect(noiseDamping(axis(0), at(clusters))).toBeCloseTo(1 - 0.35, 6)
  })

  it('charges proportionally in between, not all-or-nothing', () => {
    // Deliberately placed above the floor but well short of the cluster, so a
    // step function and a ramp give different answers here.
    const partial = noiseDamping(between(axis(0), axis(7), 0.35), at(clusters))
    expect(partial).toBeGreaterThan(1 - 0.35)
    expect(partial).toBeLessThan(1)
  })

  it('scales with the configured weight', () => {
    expect(noiseDamping(axis(0), at(clusters), 1)).toBeCloseTo(0, 6)
    expect(noiseDamping(axis(0), at(clusters), 0)).toBe(1)
  })

  // THE REASON THE CENTROIDS ARE CLUSTERED AT ALL, and the arithmetic behind it.
  //
  // For k mutually distinct noise regions, the normalized global mean sits at
  // cosine 1/sqrt(k) from each one. So the more KINDS of noise get reported,
  // the LESS the single global centroid resembles any of them -- averaging gets
  // worse exactly as the corpus gets richer, which is the opposite of what a
  // learning mechanism should do.
  //
  // Here k=4: the global mean lands at 0.5, under the 0.55 floor, and a session
  // sitting squarely inside one noise region is scored as not noise-like at all
  // and passes through unpenalized. The clustered version charges it the full
  // weight. If this test ever goes green with the global centroid penalizing,
  // the clustering has stopped earning its cost.
  it('catches noise that a single global centroid misses entirely', () => {
    const regions = [axis(0), axis(1), axis(2), axis(3)]
    const mean = regions[0].map((_, i) => regions.reduce((sum, r) => sum + r[i], 0) / regions.length)
    const onOneRegion = regions[0]

    expect(noiseDamping(onOneRegion, at(regions))).toBeCloseTo(1 - 0.35, 6)
    expect(noiseDamping(onOneRegion, at([mean]))).toBe(1)
  })
})

// Sessions 1..n are automated noise, each with the given summary vector.
const seedCorpus = (vectors: number[][]) => {
  query.mockResolvedValue({ rows: vectors.map((_, i) => ({ id: i + 1, is_automated: true })), rowCount: vectors.length })
  getEmbeddingsByIds.mockResolvedValue(new Map(vectors.map((v, i) => [`session-${i + 1}`, v])))
}

describe('the noise corpus', () => {
  it('is every session flagged automated or tagged useless', async () => {
    await loadNoiseCorpus()
    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('s.is_automated OR EXISTS')
    expect(params).toEqual([USELESS_TAG])
    // k-means seeds by position, so an unordered corpus is an unstable one.
    expect(sql).toContain('ORDER BY s.id')
  })

  it('reads each noise session by the summary vector search retrieves it by', async () => {
    seedCorpus([axis(0), axis(1)])
    const corpus = await loadNoiseCorpus()
    expect(getEmbeddingsByIds).toHaveBeenCalledWith('convo-sessions', ['session-1', 'session-2'])
    expect(corpus).toEqual([
      { sessionId: 1, vector: axis(0), source: 'automated' },
      { sessionId: 2, vector: axis(1), source: 'automated' },
    ])
  })

  it('marks a session reported by an agent apart from one sync flagged', async () => {
    query.mockResolvedValue({ rows: [{ id: 1, is_automated: true }, { id: 2, is_automated: false }], rowCount: 2 })
    getEmbeddingsByIds.mockResolvedValue(new Map([['session-1', axis(0)], ['session-2', axis(1)]]))
    expect((await loadNoiseCorpus()).map((c) => c.source)).toEqual(['automated', 'reported'])
  })

  it('normalizes what it reads', async () => {
    seedCorpus([[3, 0, 0, 0, 0, 0, 0, 0]])
    expect((await loadNoiseCorpus())[0].vector).toEqual(axis(0))
  })

  // A session reported before it was summarized has nothing to teach yet. It
  // joins by itself once summarization writes its vector.
  it('leaves out a noise session that has no summary vector yet', async () => {
    query.mockResolvedValue({ rows: [{ id: 1, is_automated: false }, { id: 2, is_automated: false }], rowCount: 2 })
    getEmbeddingsByIds.mockResolvedValue(new Map([['session-2', axis(3)]]))
    expect(await loadNoiseCorpus()).toEqual([{ sessionId: 2, vector: axis(3), source: 'reported' }])
  })

  it('checks a session for a summary vector in the sessions collection', async () => {
    hasId.mockResolvedValueOnce(false)
    expect(await hasNoiseVector(7)).toBe(false)
    expect(hasId).toHaveBeenCalledWith('convo-sessions', 'session-7')
  })
})

const corpusLoads = () =>
  query.mock.calls.filter((call) => String(call[0]).includes('s.is_automated OR EXISTS')).length

describe('calibrating the floor', () => {
  it('reads a quantile off a set of values', () => {
    expect(quantile([5, 1, 4, 2, 3], 0.5)).toBe(3)
    expect(quantile([], 0.5)).toBeNaN()
  })

  // At most (1 - quantile) of real sessions may pay anything: the floor sits at
  // the 95th percentile of how noise-like they look.
  it('puts the floor where only the top slice of real sessions sits above it', () => {
    const clusters = [axis(0)]
    const real = Array.from({ length: 20 }, (_, i) => between(axis(1), axis(0), i / 40))
    const floor = calibrateFloor(clusters, real, 0.95)
    const damped = real.filter((v) => noiseDamping(v, { centroids: clusters, floor }) < 1)
    expect(damped.length).toBeLessThanOrEqual(1)
  })

  it('moves with the clusters instead of staying where it was tuned', () => {
    const real = [between(axis(1), axis(0), 0.2), between(axis(1), axis(0), 0.4)]
    expect(calibrateFloor([axis(0)], real, 0.95)).toBeGreaterThan(calibrateFloor([axis(5)], real, 0.95))
  })

  // An uncalibrated penalty must not guess: a floor of 1 charges nothing.
  it('charges nothing when there is nothing to calibrate against', () => {
    expect(calibrateFloor([axis(0)], [], 0.95)).toBe(1)
    expect(calibrateFloor([], [axis(0)], 0.95)).toBe(1)
  })

  it('samples real sessions that nothing marks as noise, in a fixed order', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 3 }, { id: 9 }], rowCount: 2 })
    expect(await sampleRealSessionIds(2)).toEqual([3, 9])
    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('NOT s.is_automated')
    expect(sql).toContain('ORDER BY md5(s.id::text)')
    expect(params).toEqual([USELESS_TAG, 2])
  })

  it('builds the model with the floor calibrated against its own clusters', async () => {
    query.mockImplementation(async (sql: unknown) =>
      String(sql).includes('md5')
        ? { rows: [{ id: 7 }], rowCount: 1 }
        : { rows: [{ id: 1, is_automated: true }], rowCount: 1 }
    )
    getEmbeddingsByIds.mockImplementation(async (..._args: unknown[]) =>
      new Map([
        ['session-1', axis(0)],
        ['session-7', between(axis(1), axis(0), 0.3)],
      ])
    )
    const model = await getNoiseModel(1000)
    expect(model.centroids).toEqual([axis(0)])
    expect(model.floor).toBeCloseTo(calibrateFloor([axis(0)], [normalizeVector(between(axis(1), axis(0), 0.3))]), 12)
  })
})

describe('clustering the two sources of noise', () => {
  const automated = (vectors: number[][]) =>
    vectors.map((vector, i) => ({ sessionId: i + 1, vector, source: 'automated' as const }))
  const reported = (vectors: number[][]) =>
    vectors.map((vector, i) => ({ sessionId: 500 + i, vector, source: 'reported' as const }))

  // Thousands of automated runs must not be able to outvote a handful of
  // reports: a new kind of noise gets a centre of its own immediately.
  it('gives a handful of reports a cluster of their own', () => {
    const bulk = automated(Array.from({ length: 40 }, (_, i) => between(axis(i % 4), axis((i + 1) % 4), 0.3)))
    const fresh = reported([axis(6), between(axis(6), axis(7), 0.1)])
    const clusters = buildNoiseModel([...bulk, ...fresh], []).centroids
    const probe = between(axis(6), axis(7), 0.05)
    expect(noiseDamping(probe, at(clusters))).toBeLessThan(noiseDamping(probe, at(buildNoiseModel(bulk, []).centroids)))
  })

  // A report can only add noise. It must never leave anything LESS noise-like
  // than it was, which re-seating every centre jointly could do.
  it('never moves an automated cluster when reports are added', () => {
    const bulk = automated([axis(0), axis(1), axis(2), between(axis(0), axis(1), 0.5)])
    const before = buildNoiseModel(bulk, []).centroids
    const after = buildNoiseModel([...bulk, ...reported([axis(5)])], []).centroids
    expect(after.slice(0, before.length)).toEqual(before)
  })

  // The real sample is "everything not yet marked noise", so it holds the
  // unreported rest of whatever was just reported. Calibrated against every
  // cluster, the report would lift the floor over its own lookalikes.
  it('calibrates the floor against automated noise, so a report cannot cancel itself', () => {
    const bulk = automated([axis(0), axis(1)])
    const fresh = reported([axis(6)])
    const lookalikes = [between(axis(6), axis(7), 0.2), between(axis(6), axis(7), 0.25)]
    const real = [...lookalikes, between(axis(2), axis(0), 0.3), axis(3)]

    const model = buildNoiseModel([...bulk, ...fresh], real)
    expect(model.floor).toBe(buildNoiseModel(bulk, real).floor)
    expect(lookalikes.every((v) => noiseDamping(v, model) < 1)).toBe(true)
  })

  it('calibrates against reported noise when there is no automated noise at all', () => {
    const model = buildNoiseModel(reported([axis(6)]), [between(axis(1), axis(6), 0.4)])
    expect(model.floor).toBeLessThan(1)
  })

  it('has no clusters when there is no noise of either kind', () => {
    expect(buildNoiseModel([], [])).toEqual({ centroids: [], floor: 1 })
  })
})

describe('the cluster cache', () => {
  it('does not re-cluster within the cache window', async () => {
    seedCorpus([axis(0), axis(4)])
    await getNoiseModel(1000)
    await getNoiseModel(1000 + 1000)
    expect(corpusLoads()).toBe(1)
  })

  it('re-clusters once the window has passed', async () => {
    seedCorpus([axis(0), axis(4)])
    await getNoiseModel(1000)
    await getNoiseModel(1000 + 300001)
    expect(corpusLoads()).toBe(2)
  })

  // An agent that has just reported something must see the effect on its very
  // next search, not up to five minutes later. The report tools invalidate.
  it('re-clusters immediately once invalidated', async () => {
    seedCorpus([axis(0)])
    await getNoiseModel(1000)
    invalidateNoiseClusters()
    await getNoiseModel(1000)
    expect(corpusLoads()).toBe(2)
  })

  it('shares one build between searches that miss the cache together', async () => {
    seedCorpus([axis(0), axis(4)])
    const [a, b] = await Promise.all([getNoiseModel(1000), getNoiseModel(1000)])
    expect(a).toBe(b)
    expect(corpusLoads()).toBe(1)
  })

  // A report that lands while clusters are being built must not be cached over
  // by the build that started before it.
  it('does not cache a build that a report overtook', async () => {
    seedCorpus([axis(0)])
    const stale = getNoiseModel(1000)
    invalidateNoiseClusters()
    await stale
    await getNoiseModel(1000)
    expect(corpusLoads()).toBe(2)
  })

  // Ranking help is an enhancement; retrieval is the product. A corpus that
  // cannot be read must cost the penalty, never the search.
  it('degrades to no penalty when the vectors cannot be read', async () => {
    seedCorpus([axis(0)])
    getEmbeddingsByIds.mockRejectedValueOnce(new Error('chroma is down'))
    expect(await getNoiseModel(1000)).toEqual({ centroids: [], floor: 1 })
    expect(noiseDamping(axis(0), await getNoiseModel(1000))).toBe(1)
  })

  it('degrades to no penalty when the noise sessions cannot be listed', async () => {
    query.mockRejectedValueOnce(new Error('postgres is down'))
    expect(await getNoiseModel(1000)).toEqual({ centroids: [], floor: 1 })
  })

  it('has no clusters, and so no penalty, when nothing is noise', async () => {
    expect(await getNoiseModel(1000)).toEqual({ centroids: [], floor: 1 })
  })
})
