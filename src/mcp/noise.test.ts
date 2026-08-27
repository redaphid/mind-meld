import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] as unknown[], rowCount: 0 }))
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => query(...(args as [])),
}))

const getAllEmbeddings = vi.fn(async () => ({ ids: [] as string[], embeddings: [] as number[][] }))
const upsertEmbeddings = vi.fn(async (..._args: unknown[]) => {})
const deleteEmbeddings = vi.fn(async (..._args: unknown[]) => {})
vi.mock('../db/chroma.js', () => ({
  getAllEmbeddings: (...args: unknown[]) => getAllEmbeddings(...(args as [])),
  upsertEmbeddings: (...args: unknown[]) => upsertEmbeddings(...(args as [])),
  deleteEmbeddings: (...args: unknown[]) => deleteEmbeddings(...(args as [])),
}))

const generateEmbedding = vi.fn(async (_text: string) => [0, 1, 0])
vi.mock('../embeddings/ollama.js', () => ({
  generateEmbedding: (...args: unknown[]) => generateEmbedding(...(args as [string])),
}))

const mockConfig = {
  chroma: { collections: { noise: 'convo-noise' } },
  noise: { penaltyWeight: 0.35, similarityFloor: 0.55, clusterCount: 0, clusterCacheMs: 300000 },
}
vi.mock('../config.js', () => ({ config: mockConfig }))

const {
  noiseTextFor,
  resolveNoiseVector,
  recordNoiseVector,
  forgetNoiseVector,
  chooseClusterCount,
  sphericalKMeans,
  getNoiseClusters,
  invalidateNoiseClusters,
  noiseDamping,
} = await import('./noise.js')

// A unit vector pointing along one axis of a small space, so "different region
// of embedding space" is something a reader can see rather than infer.
const axis = (i: number, dims = 8): number[] => Array.from({ length: dims }, (_, d) => (d === i ? 1 : 0))

// A vector `t` of the way from a towards b, renormalized. Used to place a probe
// deliberately between two noise regions.
const between = (a: number[], b: number[], t: number): number[] => a.map((x, i) => x * (1 - t) + b[i] * t)

beforeEach(() => {
  vi.clearAllMocks()
  mockConfig.noise = { penaltyWeight: 0.35, similarityFloor: 0.55, clusterCount: 0, clusterCacheMs: 300000 }
  getAllEmbeddings.mockResolvedValue({ ids: [], embeddings: [] })
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
    expect(noiseDamping(axis(0), [])).toBe(1)
  })

  it('leaves a result untouched when it has no vector', () => {
    // Full-text-only hits have no embedding and must not be penalized on a guess.
    expect(noiseDamping(null, clusters)).toBe(1)
  })

  it('charges nothing below the similarity floor', () => {
    // Orthogonal to every cluster: as unlike the noise as this space allows.
    expect(noiseDamping(axis(7), clusters)).toBe(1)
  })

  it('charges the full weight for a result sitting on a noise cluster', () => {
    expect(noiseDamping(axis(0), clusters)).toBeCloseTo(1 - 0.35, 6)
  })

  it('charges proportionally in between, not all-or-nothing', () => {
    // Deliberately placed above the floor but well short of the cluster, so a
    // step function and a ramp give different answers here.
    const partial = noiseDamping(between(axis(0), axis(7), 0.35), clusters)
    expect(partial).toBeGreaterThan(1 - 0.35)
    expect(partial).toBeLessThan(1)
  })

  it('scales with the configured weight', () => {
    expect(noiseDamping(axis(0), clusters, 1)).toBeCloseTo(0, 6)
    expect(noiseDamping(axis(0), clusters, 0)).toBe(1)
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

    expect(noiseDamping(onOneRegion, regions)).toBeCloseTo(1 - 0.35, 6)
    expect(noiseDamping(onOneRegion, [mean])).toBe(1)
  })
})

describe('the text that stands in for a session', () => {
  it('puts the title first, because for a stub the title is the whole signal', () => {
    expect(noiseTextFor({ title: 'app - N new likes', summary: 'a notification' })).toBe(
      'app - N new likes\na notification'
    )
  })

  it('uses whichever half exists', () => {
    expect(noiseTextFor({ title: null, summary: 'only a summary' })).toBe('only a summary')
    expect(noiseTextFor({ title: 'only a title', summary: null })).toBe('only a title')
    expect(noiseTextFor({ title: null, summary: null })).toBe('')
  })
})

describe('building a session vector for the noise corpus', () => {
  it('prefers the session centroid when it has one', async () => {
    query.mockResolvedValueOnce({
      rows: [{ title: 't', summary: 's', centroid_vector: JSON.stringify([3, 0, 0]) }],
      rowCount: 1,
    })
    expect(await resolveNoiseVector(1)).toEqual([1, 0, 0])
    expect(generateEmbedding).not.toHaveBeenCalled()
  })

  // The case that matters: five of the six sessions observed polluting a live
  // search had no centroid, and all six had a summary. Refusing them would have
  // left the most representative noise out of the noise corpus.
  it('embeds title and summary when there is no centroid', async () => {
    query.mockResolvedValueOnce({
      rows: [{ title: 'a stub', summary: 'nothing happened', centroid_vector: null }],
      rowCount: 1,
    })
    expect(await resolveNoiseVector(1)).toEqual([0, 1, 0])
    expect(generateEmbedding).toHaveBeenCalledWith('a stub\nnothing happened')
  })

  it('falls back to embedding when the stored centroid is corrupt', async () => {
    query.mockResolvedValueOnce({
      rows: [{ title: 'a stub', summary: null, centroid_vector: 'not json' }],
      rowCount: 1,
    })
    expect(await resolveNoiseVector(1)).toEqual([0, 1, 0])
  })

  it('has no vector for a session with no title and no summary', async () => {
    query.mockResolvedValueOnce({ rows: [{ title: null, summary: null, centroid_vector: null }], rowCount: 1 })
    expect(await resolveNoiseVector(1)).toBeNull()
  })

  it('has no vector for a session that does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    expect(await resolveNoiseVector(404)).toBeNull()
  })

  it('stores the vector but not the session text', async () => {
    query.mockResolvedValueOnce({
      rows: [{ title: 'a stub', summary: 'nothing happened', centroid_vector: null }],
      rowCount: 1,
    })
    expect(await recordNoiseVector(7)).toBe(true)
    const [collection, payload] = upsertEmbeddings.mock.calls[0] as [string, Record<string, unknown[]>]
    expect(collection).toBe('convo-noise')
    expect(payload.ids).toEqual(['noise-session-7'])
    // The noise corpus is disproportionately personal notification content.
    // The vector is all the penalty needs; a second plaintext copy is not.
    expect(payload.documents).toEqual([''])
  })

  it('reports that it learned nothing when there was nothing to embed', async () => {
    query.mockResolvedValueOnce({ rows: [{ title: null, summary: null, centroid_vector: null }], rowCount: 1 })
    expect(await recordNoiseVector(7)).toBe(false)
    expect(upsertEmbeddings).not.toHaveBeenCalled()
  })

  it('removes the vector again on un-report', async () => {
    await forgetNoiseVector(7)
    expect(deleteEmbeddings).toHaveBeenCalledWith('convo-noise', ['noise-session-7'])
  })
})

describe('the cluster cache', () => {
  it('does not re-cluster within the cache window', async () => {
    getAllEmbeddings.mockResolvedValue({ ids: ['a', 'b'], embeddings: [axis(0), axis(4)] })
    await getNoiseClusters(1000)
    await getNoiseClusters(1000 + 1000)
    expect(getAllEmbeddings).toHaveBeenCalledTimes(1)
  })

  it('re-clusters once the window has passed', async () => {
    getAllEmbeddings.mockResolvedValue({ ids: ['a', 'b'], embeddings: [axis(0), axis(4)] })
    await getNoiseClusters(1000)
    await getNoiseClusters(1000 + 300001)
    expect(getAllEmbeddings).toHaveBeenCalledTimes(2)
  })

  // An agent that has just reported something must see the effect on its very
  // next search, not up to five minutes later.
  it('re-clusters immediately after a report invalidates it', async () => {
    getAllEmbeddings.mockResolvedValue({ ids: ['a'], embeddings: [axis(0)] })
    await getNoiseClusters(1000)
    query.mockResolvedValueOnce({
      rows: [{ title: 't', summary: 's', centroid_vector: JSON.stringify([1, 0, 0]) }],
      rowCount: 1,
    })
    await recordNoiseVector(9)
    await getNoiseClusters(1000)
    expect(getAllEmbeddings).toHaveBeenCalledTimes(2)
  })

  // Ranking help is an enhancement; retrieval is the product. An unreachable
  // noise collection must cost the penalty, never the search.
  it('degrades to no penalty when the noise collection cannot be read', async () => {
    getAllEmbeddings.mockRejectedValueOnce(new Error('chroma is down'))
    expect(await getNoiseClusters(1000)).toEqual([])
    expect(noiseDamping(axis(0), await getNoiseClusters(1000))).toBe(1)
  })

  it('has no clusters, and so no penalty, before anything is reported', async () => {
    expect(await getNoiseClusters(1000)).toEqual([])
  })
})
