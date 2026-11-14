import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BenchQuery, Manifest, Run } from './types.js'

const CODING = Array.from({ length: 12 }, (_, i) => 101 + i)
const PERSONAL = [201, 202, 203]
const UNSEARCHABLE = 104

const fake = vi.hoisted(() => ({
  maxSessionId: 900,
  corpusStatsCalls: 0,
  candidateSnapshots: [] as number[],
  realSearches: [] as unknown[],
  automated: new Set<number>(),
}))

vi.mock('./corpus.js', () => ({
  corpusStats: async () => {
    fake.corpusStatsCalls++
    return { max_session_id: fake.maxSessionId, sessions: 10 }
  },
  candidateSessions: async (dataClasses: string[], _seed: string, snapshot: number) => {
    fake.candidateSnapshots.push(snapshot)
    return dataClasses.includes('coding') ? CODING : PERSONAL
  },
  sessionCard: async (sessionId: number) =>
    sessionId === 404
      ? null
      : {
          sessionId,
          title: `title-${sessionId}`,
          summary: `summary-tangled-kite ${sessionId}`,
          summaryKind: 'generated',
          dataClass: 'coding',
          projectPath: `/projects/path-${sessionId}`,
          startedAt: null,
          chunkSummaries: [],
          messages: [{ role: 'user', text: `keyword-token-${sessionId} discussion` }],
        },
  appearsVerbatim: async (sessionId: number, text: string) => text === `keyword-token-${sessionId}`,
  realSearches: async () => fake.realSearches,
  automatedLike: async () => fake.automated,
}))

// A scripted writer: paraphrase reuses words until told which, keyword invents a
// string until told it is not verbatim, one session is not worth searching for.
// The judge grades session 301 relevant and everything else junk.
vi.mock('./claude.js', async (original) => ({
  ...(await original<typeof import('./claude.js')>()),
  callClaude: async ({ prompt }: { prompt: string }) => {
    const cards = [...prompt.matchAll(/### Candidate (C\d+)\nTitle: title-(\d+)/g)]
    if (cards.length > 0) return JSON.stringify({ grades: Object.fromEntries(cards.map(([, label, id]) => [label, id === '301' ? 3 : 0])) })
    if (prompt.startsWith('List 60 search queries')) return JSON.stringify({ queries: ['absent-topic-one', 'absent-topic-two', 'absent-topic-three'] })
    const id = Number(prompt.match(/^Title: title-(\d+)/)![1])
    if (id === UNSEARCHABLE) return JSON.stringify({ searchable: false, query: '' })
    if (prompt.includes('WITHOUT reusing'))
      return JSON.stringify({ searchable: true, query: prompt.includes('reused these words') ? 'wholly fresh phrasing' : 'discussion about keyword' })
    if (prompt.includes('Pick one exact identifier'))
      return JSON.stringify({ searchable: true, query: prompt.includes('does not appear verbatim') ? `keyword-token-${id}` : 'invented-string-zany-quokka' })
    return JSON.stringify({ searchable: true, query: `natural-query-${id}` })
  },
}))

const { buildBench } = await import('./build.js')

const resultsFor = (query: BenchQuery, ids: number[], degraded: string | null = null): Omit<Run, 'system'> => ({
  queryId: query.id,
  latencyMs: 1,
  degraded,
  results: ids.map((sessionId, i) => ({ sessionId, rank: i + 1, score: 1, matchedTier: 'session' as const, startedAt: null, snippet: `snippet-${sessionId}` })),
})

// Full text finds absent-topic-one; semantic finds 301 (judged relevant) for absent-topic-two.
const search = {
  text: async (query: BenchQuery) => resultsFor(query, query.text === 'absent-topic-one' ? [301] : []),
  semantic: async (query: BenchQuery) => resultsFor(query, query.text === 'absent-topic-two' ? [301, 302] : [303]),
}

const benchDir = () => realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'bench-build-')))
const queriesIn = (dir: string) =>
  existsSync(path.join(dir, 'queries.jsonl'))
    ? readFileSync(path.join(dir, 'queries.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as BenchQuery)
    : []
const build = (dir: string, strata: BenchQuery['stratum'][], s = search) =>
  buildBench({ dir, seed: 'seed-text-calm-reef', excludePathPatterns: ['%pattern-gusty-fern%'], search: s, strata })

beforeEach(() => {
  fake.maxSessionId = 900
  fake.corpusStatsCalls = 0
  fake.candidateSnapshots.length = 0
  fake.realSearches = []
  fake.automated = new Set()
})

describe('buildBench generated strata', () => {
  it('writes each stratum from its own dealt sessions, so no session is gold twice', async () => {
    const dir = benchDir()
    const { snapshot, counts } = await build(dir, ['natural', 'paraphrase', 'keyword', 'crossclass'])
    expect(snapshot).toBe(900)
    expect(counts).toMatchObject({ natural: 3, paraphrase: 4, keyword: 4, crossclass: 3, noanswer: 0, real: 0 })
    const queries = queriesIn(dir)
    const gold = (stratum: string) => queries.filter((q) => q.stratum === stratum).flatMap((q) => q.goldSessionIds).sort()
    expect(gold('natural')).toEqual([101, 107, 110])
    expect(gold('paraphrase')).toEqual([102, 105, 108, 111])
    expect(gold('keyword')).toEqual([103, 106, 109, 112])
    expect(gold('crossclass')).toEqual(PERSONAL)
    const all = queries.flatMap((q) => q.goldSessionIds)
    expect(new Set(all).size).toBe(all.length)
  })

  it('records what each query was written from and how it is searched', async () => {
    const dir = benchDir()
    await build(dir, ['natural', 'crossclass'])
    const [natural] = queriesIn(dir).filter((q) => q.id === 'natural-101')
    expect(natural).toMatchObject({
      stratum: 'natural',
      text: 'natural-query-101',
      dataClass: ['coding'],
      goldSessionIds: [101],
      goldSummaryKind: 'generated',
      goldProjectPath: '/projects/path-101',
      replay: {},
      notAfter: null,
      excludeSessionIds: [],
    })
    expect(queriesIn(dir).find((q) => q.stratum === 'crossclass')!.dataClass).toEqual(['*'])
  })

  // Paraphrase is built against full text: a query sharing a word with the text shown is rewritten.
  it('rewrites a paraphrase that reuses shown words', async () => {
    const dir = benchDir()
    await build(dir, ['paraphrase'])
    const queries = queriesIn(dir)
    expect(queries.map((q) => q.text)).toEqual(Array(4).fill('wholly fresh phrasing'))
    expect(queries.every((q) => q.sourceNote.endsWith('attempt 2'))).toBe(true)
  })

  it('keeps a keyword only once it appears verbatim in the session', async () => {
    const dir = benchDir()
    await build(dir, ['keyword'])
    expect(queriesIn(dir).map((q) => q.text).sort()).toEqual(['keyword-token-103', 'keyword-token-106', 'keyword-token-109', 'keyword-token-112'])
  })

  it('logs a session the writer declined instead of inventing a query for it', async () => {
    const dir = benchDir()
    await build(dir, ['natural'])
    const log = readFileSync(path.join(dir, 'build', 'writer-log.jsonl'), 'utf8')
    expect(log).toContain(JSON.stringify({ stratum: 'natural', sessionId: UNSEARCHABLE, discarded: 'not searchable' }))
    expect(queriesIn(dir).some((q) => q.goldSessionIds.includes(UNSEARCHABLE))).toBe(false)
  })

  it('writes a manifest with the snapshot, the judge and the excluded paths', async () => {
    const dir = benchDir()
    await build(dir, ['natural'])
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
    expect(manifest).toMatchObject({
      frozenAt: null,
      seed: 'seed-text-calm-reef',
      snapshotMaxSessionId: 900,
      promptVersion: 'judge-v1',
      judgeModel: 'haiku',
      excludePathPatterns: ['%pattern-gusty-fern%'],
      queriesSha256: null,
    })
  })
})

describe('buildBench reruns', () => {
  // A rerun after a crash must finish the set against the corpus it was drawn from.
  it('keeps the first snapshot and never reuses a session that is already gold', async () => {
    const dir = benchDir()
    await build(dir, ['natural'])
    fake.maxSessionId = 950
    const { snapshot, counts } = await build(dir, ['natural', 'keyword'])
    expect(snapshot).toBe(900)
    expect(fake.candidateSnapshots.every((s) => s === 900)).toBe(true)
    expect(fake.corpusStatsCalls).toBe(1)
    expect(counts).toMatchObject({ natural: 3, keyword: 4 })
    const natural = queriesIn(dir).filter((q) => q.stratum === 'natural')
    expect(natural.map((q) => q.id).sort()).toEqual(['natural-101', 'natural-107', 'natural-110'])
  })

  it('refuses to rebuild a frozen bench', async () => {
    const dir = benchDir()
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ frozenAt: '2026-01-01T00:00:00.000Z' }))
    await expect(build(dir, ['natural'])).rejects.toThrow(/is frozen/)
  })

  it('leaves a stratum that already has queries alone', async () => {
    const dir = benchDir()
    fake.realSearches = [{ toolUseId: 'tu-1', transcriptSessionId: 500, at: new Date('2026-03-10T12:00:00Z'), text: 'query-text-velvet-anchor', dataClass: [], replay: {}, originalMode: 'default', listed: [8], opened: [8] }]
    await build(dir, ['real'])
    await build(dir, ['real'])
    expect(queriesIn(dir)).toHaveLength(1)
  })
})

describe('buildBench noanswer', () => {
  it('keeps gibberish and absent topics, discarding any with a full-text hit or a semantic hit judged relevant', async () => {
    const dir = benchDir()
    const { counts } = await build(dir, ['noanswer'])
    const queries = queriesIn(dir)
    const texts = queries.map((q) => q.text)
    expect(texts).toContain('absent-topic-three')
    expect(texts).not.toContain('absent-topic-one')
    expect(texts).not.toContain('absent-topic-two')
    expect(counts.noanswer).toBe(11)
    expect(queries.every((q) => q.stratum === 'noanswer' && q.goldSessionIds.length === 0 && q.dataClass[0] === '*')).toBe(true)
    expect(new Set(queries.map((q) => q.id)).size).toBe(11)
    const checks = readFileSync(path.join(dir, 'build', 'noanswer-checks.jsonl'), 'utf8')
    expect(checks).toContain('"sessionId":301')
  })

  it('draws the same gibberish for the same seed', async () => {
    const a = benchDir()
    const b = benchDir()
    await build(a, ['noanswer'])
    await build(b, ['noanswer'])
    expect(queriesIn(a).map((q) => q.text)).toEqual(queriesIn(b).map((q) => q.text))
  })

  // A degraded semantic search returns full-text results, which cannot prove a topic absent.
  it('stops when semantic search is degraded rather than trusting full text', async () => {
    const degraded = { ...search, semantic: async (q: BenchQuery) => resultsFor(q, [], 'gate-busy') }
    await expect(build(benchDir(), ['noanswer'], degraded)).rejects.toThrow(/degraded while verifying no-answer queries: gate-busy/)
  })
})

describe('buildBench real', () => {
  const at = new Date('2026-03-10T12:00:00Z')
  const agentSearch = (toolUseId: string, opened: number[]) => ({
    toolUseId,
    transcriptSessionId: 500,
    at,
    text: `query-text-${toolUseId}`,
    dataClass: [] as string[],
    replay: { cwd: '/projects/cwd-lucky-newt' },
    originalMode: 'hybrid',
    listed: [7, ...opened],
    opened,
  })

  it('replays agent searches with their opened sessions as gold, minus later, automated or vanished ones', async () => {
    fake.automated = new Set([66])
    fake.realSearches = [agentSearch('tu-kept', [8, 9]), agentSearch('tu-later', [950]), agentSearch('tu-automated', [66]), agentSearch('tu-vanished', [404])]
    const dir = benchDir()
    await build(dir, ['real'])
    const queries = queriesIn(dir)
    expect(queries.map((q) => q.id)).toEqual(['real-tu-kept'])
    expect(queries[0]).toMatchObject({
      stratum: 'real',
      text: 'query-text-tu-kept',
      dataClass: ['coding'],
      goldSessionIds: [8, 9],
      goldProjectPath: '/projects/path-8',
      replay: { cwd: '/projects/cwd-lucky-newt' },
      notAfter: '2026-03-10T12:00:00.000Z',
      excludeSessionIds: [500],
    })
    expect(queries[0].sourceNote).toContain('first at original rank 2')
  })
})
