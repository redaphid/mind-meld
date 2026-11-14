// Usage stats against a real Postgres, on seeded search_log rows. Each number
// is checked twice: against a separately written query, and against the value
// worked out by hand from the seed. Skips without Postgres and psql, as
// src/db/migrations.test.ts does.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { runMigrations } from '../db/migrations.js'
import { withMigrationLock } from '../__tests__/pg-migration-lock.js'

const PG = {
  host: process.env.POSTGRES_HOST ?? '127.0.0.1',
  port: parseInt(process.env.POSTGRES_PORT ?? '5433', 10),
  user: process.env.POSTGRES_USER ?? 'mindmeld',
  password: process.env.POSTGRES_PASSWORD ?? 'mindmeld',
}

const reachable = async (): Promise<boolean> => {
  const client = new pg.Client({ ...PG, database: 'postgres', connectionTimeoutMillis: 1500 })
  try {
    await client.connect()
    await promisify(execFile)('psql', ['--version'])
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}

const dbAvailable = await reachable()
const database = `mm_test_usage_${randomBytes(4).toString('hex')}`

type Seed = {
  ago: string
  client?: string
  kind: 'search' | 'open' | 'tag'
  list?: string
  request?: Record<string, unknown>
  mode?: string
  sessions?: number[]
  error?: string
  degraded?: string
  ms?: number
  stages?: Record<string, number>
  rank?: number | null
  signal?: string
}

const S = (list: string, ago: string, over: Partial<Seed> = {}): Seed =>
  ({ kind: 'search', list, ago, mode: 'hybrid', request: { query: 'q' }, sessions: [101, 102, 103], ms: 10, ...over })
const open = (list: string, ago: string, rank: number | null, client?: string): Seed =>
  ({ kind: 'open', list, ago, rank, signal: 'open', client })

// Relative to now. "+2m" style offsets are written as the search's age minus
// the gap, so an open lands that many minutes after its search.
const SEED: Seed[] = [
  S('L1', '1 day', { ms: 10, stages: { embedMs: 4, sessionMs: 3, fullTextMs: 2 } }),
  open('L1', '1 day -2 minutes', 2),
  open('L1', '1 day -3 minutes', 1),
  S('L2', '2 days', { mode: 'text', sessions: [], ms: 20 }),
  S('L3', '3 days', { degraded: 'switched-off', ms: 30, stages: { embedMs: 8, fullTextMs: 6 }, request: { query: 'q', negativeQuery: 'x' } }),
  open('L3', '3 days -15 minutes', 1),
  S('L4', '1 day', { mode: 'semantic', error: 'Error', ms: 5, stages: { embedMs: 500 }, request: { query: 'q', likeSession: ['7'] } }),
  S('L8', '2 days', { sessions: [104], ms: 15, stages: { embedMs: 6 } }),
  open('L8', '2 days -1 minute', null),
  S('L5', '10 days', { client: 'web-ui', ms: 40, stages: { embedMs: 20 }, request: { q: 'q', not: 'y' } }),
  open('L5', '10 days -1 minute', 3),
  S('L6', '1 day', { client: 'bench', ms: 900, request: { query: 'q', likeProject: ['1'] } }),
  open('L6', '1 day -1 minute', 1, 'bench'),
  S('L7', '40 days', { ms: 50, request: { query: 'q', negativeQuery: '' } }),
  { kind: 'tag', ago: '1 day', signal: 'tag' },
  { kind: 'tag', ago: '2 days', signal: 'useless' },
  { kind: 'tag', ago: '1 day', signal: 'tag', client: 'bench' },
]

const BASE = `client NOT LIKE 'bench%' AND client NOT LIKE 'eval%' AND at > now() - $1::int * interval '1 day'`

// Written without the module's CTEs: correlated subqueries and FILTER.
const HAND = {
  searches: `SELECT count(*)::int AS v FROM search_log WHERE kind = 'search' AND ${BASE}`,
  openedShare: `
    SELECT (count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM search_log o WHERE o.kind = 'open' AND o.list = s.list
                AND o.at BETWEEN s.at AND s.at + interval '10 minutes')))::float8 / count(*) AS v
    FROM search_log s WHERE kind = 'search' AND error IS NULL AND ${BASE}`,
  firstRanks: `
    SELECT (SELECT o.rank FROM search_log o WHERE o.kind = 'open' AND o.list = s.list
              AND o.at BETWEEN s.at AND s.at + interval '10 minutes' ORDER BY o.at LIMIT 1) AS r
    FROM search_log s WHERE kind = 'search' AND error IS NULL AND ${BASE}`,
  noResultRate: `SELECT avg((result_count = 0)::int)::float8 AS v FROM search_log WHERE kind = 'search' AND error IS NULL AND ${BASE}`,
  degradedRate: `SELECT avg((degraded IS NOT NULL)::int)::float8 AS v FROM search_log WHERE kind = 'search' AND error IS NULL AND ${BASE}`,
  latency: `
    SELECT percentile_cont(ARRAY[0.5, 0.9]) WITHIN GROUP (ORDER BY (timings->>'totalMs')::float8) AS v
    FROM search_log WHERE kind = 'search' AND error IS NULL AND ${BASE}`,
  stage: `
    SELECT percentile_cont(ARRAY[0.5, 0.9]) WITHIN GROUP (ORDER BY (timings->>$2)::float8) AS v
    FROM search_log WHERE kind = 'search' AND error IS NULL AND ${BASE}`,
  feedbackPerSearch: `
    SELECT (SELECT count(*) FROM search_log WHERE kind = 'tag' AND ${BASE})::float8
         / (SELECT count(*) FROM search_log WHERE kind = 'search' AND error IS NULL AND ${BASE}) AS v`,
  negativeQuery: `
    SELECT count(*)::int AS v FROM search_log
    WHERE kind = 'search' AND ${BASE} AND COALESCE(NULLIF(request->>'negativeQuery', ''), NULLIF(request->>'not', '')) IS NOT NULL`,
  likeSession: `
    SELECT count(*)::int AS v FROM search_log
    WHERE kind = 'search' AND ${BASE} AND jsonb_array_length(COALESCE(request->'likeSession', '[]')) > 0`,
  perDay: `
    SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, client, mode, count(*)::int AS searches
    FROM search_log WHERE kind = 'search' AND ${BASE}
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
}

describe.skipIf(!dbAvailable)('usage stats against Postgres', () => {
  const admin = new pg.Client({ ...PG, database: 'postgres' })
  let db: pg.Client
  let mod: {
    stats: typeof import('./usage-stats.js')
    tools: typeof import('./tools.js')
    closePool: () => Promise<void>
  }

  const hand = async (sql: string, days: number) => (await db.query(sql, [days])).rows

  beforeAll(async () => {
    await admin.connect()
    await admin.query(`CREATE DATABASE ${database}`)
    await withMigrationLock(PG, () => runMigrations({ ...PG, database }))
    db = new pg.Client({ ...PG, database })
    await db.connect()
    for (const r of SEED) {
      const results = r.sessions ? JSON.stringify(r.sessions.map((s, i) => ({ s, rank: i + 1 }))) : null
      await db.query(
        `INSERT INTO search_log (at, caller, transport, client, kind, tool, list, request, mode, results,
                                 result_count, degraded, error, timings, rank, signal)
         VALUES (now() - $1::interval, 'mcp:c', 'mcp-http', $2, $3, 'search', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          r.ago, r.client ?? 'claude-code/1.0', r.kind, r.list ?? null, r.request ?? null,
          r.kind === 'search' ? r.mode : null, r.error ? null : results,
          r.kind === 'search' && !r.error ? r.sessions?.length : null,
          r.degraded ?? null, r.error ?? null, r.ms === undefined ? null : { totalMs: r.ms, ...r.stages },
          r.rank ?? null, r.signal ?? null,
        ]
      )
    }
    process.env.POSTGRES_DB = database
    process.env.POSTGRES_HOST = PG.host
    process.env.POSTGRES_PORT = String(PG.port)
    const { closePool } = await import('../db/postgres.js')
    mod = { stats: await import('./usage-stats.js'), tools: await import('./tools.js'), closePool }
  }, 120_000)

  afterAll(async () => {
    await mod?.closePool().catch(() => {})
    await db?.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {})
    await admin.end().catch(() => {})
  }, 60_000)

  // Worked out by hand from SEED. 7 days: L1 L2 L3 L4 L8 (L4 threw). 30 days adds L5.
  const EXPECTED = {
    7: { searches: 5, openedShare: 2 / 4, median: 2, mrr: 1 / 2, noResult: 1 / 4, degraded: 1 / 4,
         p50: 17.5, p90: 27, feedback: 2 / 4, negativeQuery: 1, likeSession: 1,
         embed: [6, 7.6], session: [3, 3], fullText: [4, 5.6] },
    30: { searches: 6, openedShare: 3 / 5, median: 2.5, mrr: (1 / 2 + 1 / 3) / 2, noResult: 1 / 5, degraded: 1 / 5,
          p50: 20, p90: 36, feedback: 2 / 5, negativeQuery: 2, likeSession: 1,
          embed: [7, 16.4], session: [3, 3], fullText: [4, 5.6] },
  } as const

  for (const days of [7, 30] as const) {
    it(`matches the hand-written queries and the hand count over ${days} days`, async () => {
      const s = await mod.stats.usageStats(days)
      const want = EXPECTED[days]
      const v = async (sql: string) => (await hand(sql, days))[0].v

      expect(s.searches).toBe(await v(HAND.searches))
      expect(s.searches).toBe(want.searches)

      expect(s.openedShare).toBeCloseTo(await v(HAND.openedShare), 9)
      expect(s.openedShare).toBeCloseTo(want.openedShare, 9)

      const ranks = (await hand(HAND.firstRanks, days)).map((r) => r.r).filter((r) => r !== null).sort((a, b) => a - b)
      const mid = ranks.length / 2
      const median = ranks.length % 2 ? ranks[Math.floor(mid)] : (ranks[mid - 1] + ranks[mid]) / 2
      expect(s.openedRank.opens).toBe(ranks.length)
      expect(s.openedRank.median).toBe(median)
      expect(s.openedRank.median).toBe(want.median)
      expect(s.openedRank.mrr).toBeCloseTo(ranks.reduce((a, r) => a + 1 / r, 0) / ranks.length, 9)
      expect(s.openedRank.mrr).toBeCloseTo(want.mrr, 9)

      expect(s.noResultRate).toBeCloseTo(await v(HAND.noResultRate), 9)
      expect(s.noResultRate).toBeCloseTo(want.noResult, 9)
      expect(s.degradedRate).toBeCloseTo(await v(HAND.degradedRate), 9)
      expect(s.degradedRate).toBeCloseTo(want.degraded, 9)

      const [p50, p90] = await v(HAND.latency)
      expect([s.latencyMs.p50, s.latencyMs.p90]).toEqual([p50, p90])
      expect(s.latencyMs.p50).toBeCloseTo(want.p50, 9)
      expect(s.latencyMs.p90).toBeCloseTo(want.p90, 9)

      for (const stage of mod.stats.STAGES) {
        const [h50, h90] = (await db.query(HAND.stage, [days, stage])).rows[0].v ?? [null, null]
        expect([s.stageMs[stage].p50, s.stageMs[stage].p90]).toEqual([h50, h90])
      }
      for (const [stage, [p50, p90]] of [['embedMs', want.embed], ['sessionMs', want.session], ['fullTextMs', want.fullText]] as const) {
        expect(s.stageMs[stage].p50).toBeCloseTo(p50, 9)
        expect(s.stageMs[stage].p90).toBeCloseTo(p90, 9)
      }
      expect(s.stageMs.chunkMs).toEqual({ p50: null, p90: null })

      expect(s.feedbackPerSearch).toBeCloseTo(await v(HAND.feedbackPerSearch), 9)
      expect(s.feedbackPerSearch).toBeCloseTo(want.feedback, 9)

      expect(s.vectorParams.negativeQuery).toBe(await v(HAND.negativeQuery))
      expect(s.vectorParams.negativeQuery).toBe(want.negativeQuery)
      expect(s.vectorParams.likeSession).toBe(await v(HAND.likeSession))
      expect(s.vectorParams.likeSession).toBe(want.likeSession)
      expect(s.vectorParams).toMatchObject({ unlikeSession: 0, likeProject: 0, unlikeProject: 0 })

      const perDay = (await hand(HAND.perDay, days)).map((d) => ({ ...d, client: d.client.split('/')[0] }))
      expect(s.perDay).toEqual(perDay)
      expect(s.perDay.reduce((a, d) => a + d.searches, 0)).toBe(want.searches)
    })
  }

  it('serves the same numbers through the stats tool', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'pg-test', version: '1' })
    await Promise.all([mod.tools.createMcpServer('mcp-http').connect(serverTransport), client.connect(clientTransport)])
    const res = await client.callTool({ name: 'stats', arguments: {} })
    const out = (res.content as { text: string }[])[0].text
    expect(out).toContain('| Searches | 5 | 6 |')
    expect(out).toContain('| Opened within 10 min | 50.0% | 60.0% |')
    expect(out).toContain('| Opened rank, median | 2.0 | 2.5 |')
    expect(out).toContain('| Uses negativeQuery | 1 | 2 |')
    await client.close()
  })

  // Last: it adds 50k rows the tests above do not expect.
  it('answers over a large log in seconds, not minutes', async () => {
    await db.query(
      `INSERT INTO search_log (at, caller, transport, client, kind, tool, list, results, result_count, timings)
       SELECT now() - (g % 40) * interval '1 day' - interval '1 hour', 'mcp:load', 'mcp-http', 'claude-code/1',
              'search', 'search', 'P' || g, '[{"s":1,"rank":1}]', 1, '{"totalMs":10}'
       FROM generate_series(1, 25000) g`
    )
    await db.query(
      `INSERT INTO search_log (at, caller, transport, client, kind, tool, list, rank, signal)
       SELECT now() - (g % 40) * interval '1 day' - interval '59 minutes', 'mcp:load', 'mcp-http', 'claude-code/1',
              'open', 'getSession', 'P' || g, 1, 'open'
       FROM generate_series(1, 25000) g`
    )
    await db.query('ANALYZE search_log')
    const started = performance.now()
    const s = await mod.stats.usageStats(30)
    expect(performance.now() - started).toBeLessThan(5000)
    expect(s.openedRank.opens).toBeGreaterThan(18000)
  }, 60_000)
})
