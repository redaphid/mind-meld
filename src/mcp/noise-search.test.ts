import { describe, it, expect, vi, beforeEach } from 'vitest'

// END-TO-END through searchWithDiagnostics: reported stubs leave the default
// results, real conversations do NOT, and includeNoise brings the stubs back.
//
// The corpus below is a scale model of the real one, and the geometry is the
// point rather than decoration. In the live index the real DM threads sit
// ADJACENT to the phone's notification stubs in embedding space -- same app,
// same people, often the same words -- so a penalty crude enough
// to remove the stubs is very capable of removing the conversations with them.
// That is why there are two signal sessions here: one comfortably clear of the
// noise, and one deliberately close enough to be charged part of the penalty.
// A version of this feature that only passes with the easy one is not finished.

const query = vi.fn()
vi.mock('../db/postgres.js', () => ({ query: (...args: unknown[]) => query(...args) }))

const querySimilar = vi.fn()
const getAllEmbeddings = vi.fn()
vi.mock('../db/chroma.js', () => ({
  querySimilar: (...args: unknown[]) => querySimilar(...args),
  getAllEmbeddings: (...args: unknown[]) => getAllEmbeddings(...args),
  upsertEmbeddings: vi.fn(),
  deleteEmbeddings: vi.fn(),
}))

vi.mock('../embeddings/ollama.js', () => ({
  getInteractiveOllamaClient: () => ({ embed: async () => ({ embeddings: [unit(0)] }) }),
  generateEmbedding: async () => unit(0),
}))

const DIMS = 1024

// A unit vector along one axis, and a blend of two axes at a chosen angle, so
// "how alike are these two things" is a number the test states rather than a
// property of some opaque fixture.
function unit(axis: number): number[] {
  const v = new Array(DIMS).fill(0)
  v[axis] = 1
  return v
}
const blend = (cosToAxis0: number): number[] => {
  const v = new Array(DIMS).fill(0)
  v[0] = cosToAxis0
  v[1] = Math.sqrt(1 - cosToAxis0 * cosToAxis0)
  return v
}

// weight 0.35, floor 0.55 -- the shipped defaults.
const REPORTED_STUB = unit(0) //          cos 1.00 to the noise cluster
const UNREPORTED_STUB = blend(0.98) //    cos 0.98 -- heavily damped
const ADJACENT_DM = blend(0.62) //        cos 0.62 -- just above the floor, lightly damped
const CLEAR_DM = blend(0.5) //            cos 0.50 -- under the floor, untouched
const CODING = unit(5) //                 cos 0.00 -- untouched

const { searchWithDiagnostics } = await import('./search.js')
const { invalidateNoiseClusters } = await import('./noise.js')

const sessionRow = (id: number, title: string, source: string, dataClass: string) => ({
  id,
  title,
  summary: 'a summary',
  project_name: 'proj',
  project_path: '/p/proj',
  source_name: source,
  data_class: dataClass,
  started_at: new Date('2026-01-01T00:00:00Z'),
  message_count: 10,
  project_id: 7,
})

const SESSIONS: Record<number, Record<string, unknown>> = {
  1: sessionRow(1, 'a reported notification stub', 'android', 'personal'),
  2: sessionRow(2, 'an unreported notification stub', 'android', 'personal'),
  3: sessionRow(3, 'a DM thread that sits near the stubs', 'chat_app', 'personal'),
  4: sessionRow(4, 'a DM thread further away', 'chat_app', 'personal'),
  5: sessionRow(5, 'fixing the build', 'claude_code', 'coding'),
}

// Chroma's ranking, before any penalty. The reported and unreported stubs come
// back FIRST -- which is the actual complaint this feature exists to answer.
const ORDER = [1, 2, 3, 4, 5]
const VECTORS: Record<number, number[]> = {
  1: REPORTED_STUB,
  2: UNREPORTED_STUB,
  3: ADJACENT_DM,
  4: CLEAR_DM,
  5: CODING,
}

// Session 1 has been reported: it carries the "useless" tag and its vector is
// in the noise corpus.
let taggedUseless = [1]

beforeEach(() => {
  taggedUseless = [1]
  // The cluster cache is module state and outlives a test. Without this, a test
  // that seeds an empty noise corpus still gets the PREVIOUS test's clusters --
  // which is exactly how the "behaves as before" case first went red.
  invalidateNoiseClusters()
  query.mockReset()
  querySimilar.mockReset()
  getAllEmbeddings.mockReset()

  getAllEmbeddings.mockResolvedValue({ ids: ['noise-session-1'], embeddings: [REPORTED_STUB] })

  querySimilar.mockImplementation(async (collection: string) => {
    if (collection !== 'convo-sessions') return { ids: [[]], distances: [[]], embeddings: [[]] }
    return {
      ids: [ORDER.map((id) => `session-${id}`)],
      distances: [ORDER.map((_, i) => 0.1 + i * 0.01)],
      embeddings: [ORDER.map((id) => VECTORS[id])],
    }
  })

  query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('s.id = $1')) {
      const row = SESSIONS[params?.[0] as number]
      return { rows: row ? [row] : [] }
    }
    // resolveTagFilter's exclude arm.
    if (sql.includes('FROM tags WHERE tag = ANY'))
      return { rows: taggedUseless.map((id) => ({ session_id: id, message_id: null })) }
    // resolveTagFilter's include arm.
    if (sql.includes('COALESCE(t.session_id, m.session_id)'))
      return { rows: taggedUseless.map((id) => ({ session_id: id })) }
    return { rows: [] }
  })
})

const idsOf = async (params: Record<string, unknown>) =>
  (await searchWithDiagnostics({ query: 'anything', mode: 'semantic', dataClass: ['*'], limit: 10, ...params }))
    .results.map((r) => r.session_id)

const scoreOf = async (params: Record<string, unknown>, sessionId: number) => {
  const { results } = await searchWithDiagnostics({
    query: 'anything',
    mode: 'semantic',
    dataClass: ['*'],
    limit: 10,
    ...params,
  })
  return results.find((r) => r.session_id === sessionId)?.score
}

describe('reported noise, end to end through search', () => {
  it('hides a reported session from the default results', async () => {
    expect(await idsOf({})).not.toContain(1)
  })

  it('brings the reported session back with includeNoise', async () => {
    expect(await idsOf({ includeNoise: true })).toContain(1)
  })

  it('still reaches it by asking for the tag by name', async () => {
    expect(await idsOf({ tags: ['useless'] })).toContain(1)
  })

  // THE HALF THAT IS NOT JUST HIDING. Session 2 was never reported by anyone.
  // It ranks first at retrieval time and it is still in the results -- but it
  // has been pushed behind both real conversations purely because it resembles
  // the one session somebody did report.
  it('ranks an unreported lookalike below the real conversations', async () => {
    const ids = await idsOf({})
    expect(ids).toContain(2)
    expect(ids.indexOf(2)).toBeGreaterThan(ids.indexOf(3))
    expect(ids.indexOf(2)).toBeGreaterThan(ids.indexOf(4))
  })

  it('leaves the lookalike ahead of the real conversations when the penalty is off', async () => {
    // Same corpus, same retrieval order, penalty disabled: session 2 is back in
    // front. Without this, the assertion above could be satisfied by the
    // fixture's ordering rather than by the penalty.
    const ids = await idsOf({ includeNoise: true })
    expect(ids.indexOf(2)).toBeLessThan(ids.indexOf(3))
    expect(ids.indexOf(2)).toBeLessThan(ids.indexOf(4))
  })

  it('does not drop the DM thread that sits closest to the noise', async () => {
    const ids = await idsOf({})
    expect(ids).toContain(3)
    expect(ids).toContain(4)
  })

  it('leaves a conversation clear of the noise scored exactly as before', async () => {
    // Sessions 4 and 5 are under the similarity floor, so their scores must be
    // bit-for-bit the untouched reciprocal-rank values. A penalty that quietly
    // taxes everything reorders nothing and costs real relevance, and only an
    // exact comparison catches that -- an approximate one would pass.
    //
    // With session 1 hidden the surviving ranked list is [2, 3, 4, 5], so
    // session 4 sits at rank index 2 and session 5 at 3. RRF k = 60.
    expect(await scoreOf({}, 4)).toBe(1 / 63)
    expect(await scoreOf({}, 5)).toBe(1 / 64)
  })

  it('charges the adjacent DM thread something, but not enough to sink it', async () => {
    const penalized = (await scoreOf({}, 3)) as number
    const unpenalized = (await scoreOf({ includeNoise: true }, 3)) as number
    expect(penalized).toBeLessThan(unpenalized)
    // It is still ahead of the lookalike stub, which is the outcome that matters.
    const ids = await idsOf({})
    expect(ids.indexOf(3)).toBeLessThan(ids.indexOf(2))
  })

  it('behaves exactly as before when nothing has been reported', async () => {
    taggedUseless = []
    getAllEmbeddings.mockResolvedValue({ ids: [], embeddings: [] })
    expect(await idsOf({})).toEqual([1, 2, 3, 4, 5])
  })
})
