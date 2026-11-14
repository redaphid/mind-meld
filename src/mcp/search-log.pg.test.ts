// The search log end to end against a real Postgres: real migrations, the real
// tool surface over an in-memory MCP client, real inserts and linking SQL.
// Needs a reachable Postgres and the psql binary (to apply init-db); skips
// without them, as src/db/migrations.test.ts does.
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
const database = `mm_test_searchlog_${randomBytes(4).toString('hex')}`

describe.skipIf(!dbAvailable)('search log against Postgres', () => {
  const admin = new pg.Client({ ...PG, database: 'postgres' })
  let db: pg.Client
  let sessionId: number
  let mod: {
    tools: typeof import('./tools.js')
    log: typeof import('./search-log.js')
    closePool: () => Promise<void>
  }

  const rows = async () =>
    (await db.query(`SELECT * FROM search_log ORDER BY id`)).rows

  const mcpClient = async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'pg-test', version: '1' })
    await Promise.all([mod.tools.createMcpServer('mcp-http').connect(serverTransport), client.connect(clientTransport)])
    return client
  }

  beforeAll(async () => {
    await admin.connect()
    await admin.query(`CREATE DATABASE ${database}`)
    await withMigrationLock(PG, () => runMigrations({ ...PG, database }))
    db = new pg.Client({ ...PG, database })
    await db.connect()
    // Full text only: no Chroma or Ollama in a test database.
    await db.query(`UPDATE sync_control SET semantic_enabled = false`)
    const src = await db.query(`SELECT id FROM sources WHERE name = 'claude_code'`)
    const project = await db.query(
      `INSERT INTO projects (source_id, external_id, path, name) VALUES ($1, 'p1', '/p/one', 'one') RETURNING id`,
      [src.rows[0].id]
    )
    const session = await db.query(
      `INSERT INTO sessions (project_id, external_id, title, summary, started_at, ended_at, message_count)
       VALUES ($1, 's1', 'Zebra crossing', 'we discussed the zebra crossing', now(), now(), 1) RETURNING id`,
      [project.rows[0].id]
    )
    sessionId = session.rows[0].id
    await db.query(
      `INSERT INTO messages (session_id, external_id, role, content_text, timestamp, sequence_num)
       VALUES ($1, 'm1', 'user', 'how wide is a zebra crossing on a busy road', now(), 0)`,
      [sessionId]
    )
    // config reads the environment once, at import.
    process.env.POSTGRES_DB = database
    process.env.POSTGRES_HOST = PG.host
    process.env.POSTGRES_PORT = String(PG.port)
    const { closePool } = await import('../db/postgres.js')
    mod = { tools: await import('./tools.js'), log: await import('./search-log.js'), closePool }
  }, 120_000)

  afterAll(async () => {
    await mod?.closePool().catch(() => {})
    await db?.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {})
    await admin.end().catch(() => {})
  }, 60_000)

  it('links a search and the getSession after it by caller and by rank', async () => {
    const client = await mcpClient()
    const out = (await client.callTool({ name: 'search', arguments: { query: 'zebra crossing', mode: 'text' } })) as {
      content: { text: string }[]
    }
    await client.callTool({ name: 'getSession', arguments: { sessionId } })
    await client.close()
    await mod.log.searchLog.flushed()

    const [search, open] = await rows()
    expect(out.content[0].text).toContain(`(list ${search.list})`)
    expect(search).toMatchObject({ kind: 'search', tool: 'search', mode: 'text', result_count: 1, degraded: null })
    expect(search.request).toEqual({ query: 'zebra crossing', mode: 'text' })
    expect(search.results).toEqual([expect.objectContaining({ s: sessionId, rank: 1, tier: 'message' })])
    expect(search.timings.totalMs).toBeGreaterThan(0)
    expect(search.timings).toEqual({ totalMs: expect.any(Number), semanticMs: null, fullTextMs: expect.any(Number) })
    expect(open).toMatchObject({ kind: 'open', tool: 'getSession', signal: 'open', session_id: sessionId, rank: 1, list: search.list })
    expect(open.caller).toBe(search.caller)
    expect(open.client).toBe('pg-test/1')
  })

  it('links an open from another caller only when it names the list', async () => {
    const [search] = await rows()
    const other = { key: 'rest:ui:tab2', transport: 'rest' as const, client: 'web-ui' }
    const base = { kind: 'follow-up' as const, at: new Date(), caller: other, tool: 'rest:session' as const, request: {} }
    mod.log.searchLog.record({ ...base, target: { sessionId }, list: null })
    mod.log.searchLog.record({ ...base, target: { sessionId }, list: search.list })
    await mod.log.searchLog.flushed()
    const [, , unnamed, named] = await rows()
    expect(unnamed).toMatchObject({ list: null, rank: null, session_id: sessionId })
    expect(named).toMatchObject({ list: search.list, rank: 1 })
  })

  it('resolves the session of a message-level follow-up', async () => {
    const message = await db.query(`SELECT id FROM messages WHERE session_id = $1`, [sessionId])
    const client = await mcpClient()
    await client.callTool({ name: 'getMessage', arguments: { id: Number(message.rows[0].id) } })
    await client.close()
    await mod.log.searchLog.flushed()
    const last = (await rows()).at(-1)
    expect(last).toMatchObject({ tool: 'getMessage', session_id: sessionId })
  })

  it('still answers a search when the log cannot be written, and counts the failure', async () => {
    const before = mod.log.searchLog.stats().failed
    await db.query(`ALTER TABLE search_log RENAME TO search_log_away`)
    try {
      const client = await mcpClient()
      const out = (await client.callTool({ name: 'search', arguments: { query: 'zebra', mode: 'text' } })) as {
        content: { text: string }[]
        isError?: boolean
      }
      await client.close()
      await mod.log.searchLog.flushed()
      expect(out.isError).toBeFalsy()
      expect(out.content[0].text).toContain('Zebra crossing')
      expect(mod.log.searchLog.stats()).toMatchObject({ failed: before + 1, lastFailureCode: '42P01' })
    } finally {
      await db.query(`ALTER TABLE search_log_away RENAME TO search_log`)
    }
  })

  it('nulls query text past retention and keeps the rest of the row', async () => {
    await db.query(
      `INSERT INTO search_log (at, caller, transport, client, kind, tool, request, request_hash)
       VALUES (now() - interval '200 days', 'mcp:old', 'mcp-http', 'x', 'search', 'search', '{"query":"old"}', 'h-old')`
    )
    expect(await mod.log.expireRawRequests(180)).toBe(1)
    const old = await db.query(`SELECT request, request_hash FROM search_log WHERE caller = 'mcp:old'`)
    expect(old.rows[0]).toEqual({ request: null, request_hash: 'h-old' })
    const recent = await db.query(`SELECT count(*)::int AS n FROM search_log WHERE request IS NOT NULL`)
    expect(recent.rows[0].n).toBeGreaterThan(0)
  })
})
