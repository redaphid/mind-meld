// A pasted Slack permalink against real PostgreSQL, with Ollama pointed at a
// closed port: a search that tried to embed would come back degraded.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { PG, applyInitDb, createScratchDatabase, dbAvailable } from '../__tests__/scratch-database.js'

const THREAD = 'https://valley-of-the-sun.slack.com/archives/C0LAIR/p1731370000123456'
const REPLY = `${THREAD}?thread_ts=1731360000.000100&cid=C0LAIR`

describe.skipIf(!dbAvailable)('search for a pasted permalink', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let client: pg.Client
  let mod: { search: typeof import('./search.js'); closePool: () => Promise<void> }
  const sessions: Record<string, number> = {}

  beforeAll(async () => {
    scratch = await createScratchDatabase('permalink_search')
    await applyInitDb(scratch.name)
    client = new pg.Client({ ...PG, database: scratch.name })
    await client.connect()
    const { rows: [source] } = await client.query<{ id: number }>(
      `INSERT INTO sources (name, display_name, data_class) VALUES ('slack:thunderwrench', 'Thunderwrench HVAC Co.', 'slack') RETURNING id`)
    const { rows: [project] } = await client.query<{ id: number }>(
      `INSERT INTO projects (source_id, external_id) VALUES ($1, 'C0LAIR') RETURNING id`, [source.id])
    const seed = async (name: string, permalink: string) => {
      const { rows: [session] } = await client.query<{ id: number }>(
        `INSERT INTO sessions (project_id, external_id, summary) VALUES ($1, $2, 'The Rusty Conquistador thread') RETURNING id`,
        [project.id, name])
      await client.query(
        `INSERT INTO messages (session_id, external_id, role, content_text, content_json, timestamp)
         VALUES ($1, $2, 'user', 'The clockwork squid has landed in the lair', $3, now())`,
        [session.id, `${name}-message`, { permalink }])
      sessions[name] = session.id
    }
    await seed('thread-root', THREAD)
    await seed('thread-reply', 'https://valley-of-the-sun.slack.com/archives/C0LAIR/p1731379999000001?thread_ts=1731370000.123456&cid=C0LAIR')
    process.env.POSTGRES_DB = scratch.name
    process.env.POSTGRES_HOST = PG.host
    process.env.POSTGRES_PORT = String(PG.port)
    process.env.OLLAMA_URL = 'http://127.0.0.1:9'
    process.env.CHROMA_PORT = '9'
    const { closePool } = await import('../db/postgres.js')
    mod = { search: await import('./search.js'), closePool }
  }, 120_000)

  afterAll(async () => {
    await mod?.closePool().catch(() => {})
    await client?.end().catch(() => {})
    await scratch?.drop()
  }, 60_000)

  describe.each([
    ['when the bare permalink is pasted', THREAD, 'thread-root'],
    ['when the permalink carries a thread_ts query', REPLY, 'thread-root'],
    ['when a reply stored with thread_ts is pasted without it', 'https://valley-of-the-sun.slack.com/archives/C0LAIR/p1731379999000001', 'thread-reply'],
  ])('%s', (_, url, expected) => {
    let outcome: Awaited<ReturnType<typeof import('./search.js').searchWithDiagnostics>>

    beforeAll(async () => {
      outcome = await mod.search.searchWithDiagnostics({ query: url })
    })

    it('should find only that conversation', () => {
      expect(outcome.results.map((r) => r.session_id)).toEqual([sessions[expected]])
    })

    it('should not ask for an embedding', () => {
      expect(outcome.degraded).toBeNull()
    })
  })
})
