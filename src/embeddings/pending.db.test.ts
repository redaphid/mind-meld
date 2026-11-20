// The embedder's selection against real PostgreSQL. On 2026-11-18, with 5.4M
// messages, it sorted every eligible row (content_text included, 1.2 GB on
// disk) before discarding the embedded ones, and hit the 120s statement
// timeout. Walking the eligible index newest-first and stopping at LIMIT took
// 235ms. The plan, not the rows, is what regressed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { PG, applyInitDb, createScratchDatabase, dbAvailable } from '../__tests__/scratch-database.js'
import { nextMessagesToEmbed } from './pending.js'

describe.skipIf(!dbAvailable)('nextMessagesToEmbed', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let client: pg.Client

  beforeAll(async () => {
    scratch = await createScratchDatabase('pending_plan')
    await applyInitDb(scratch.name)
    client = new pg.Client({ ...PG, database: scratch.name })
    await client.connect()
  }, 120_000)

  afterAll(async () => {
    await client?.end()
    await scratch?.drop()
  })

  // The production shape: a large index, nearly all of it already embedded.
  // An empty table plans differently, so it cannot catch the regression.
  describe('when most messages are already embedded', () => {
    let plan: string

    beforeAll(async () => {
      await client.query(`
        WITH src AS (
          INSERT INTO sources (name, display_name) VALUES ('source-lair', 'The Lair') RETURNING id
        ), proj AS (
          INSERT INTO projects (source_id, external_id) SELECT id, 'project-rusty-conquistador' FROM src RETURNING id
        )
        INSERT INTO sessions (project_id, external_id) SELECT id, 'session-valley-of-the-sun' FROM proj`)
      await client.query(`
        INSERT INTO messages (session_id, external_id, role, content_text, timestamp)
        SELECT (SELECT id FROM sessions WHERE external_id = 'session-valley-of-the-sun'),
               'message-thunderwrench-' || n, 'user', 'Thunderwrench HVAC Co. dispatch note ' || n,
               TIMESTAMPTZ '2026-01-01' + n * INTERVAL '1 minute'
        FROM generate_series(1, 50000) n`)
      await client.query(`
        INSERT INTO embeddings (message_id, chroma_collection, chroma_id)
        SELECT id, 'convo-messages', 'chroma-id-' || id FROM messages WHERE id % 50 <> 0`)
      await client.query('ANALYZE')
      // At this size a full sort really is cheapest, so ask whether the index
      // CAN serve the order: with sorting priced out, a plan that still sorts
      // is one whose ORDER BY the index does not match.
      await client.query('SET enable_sort = off')
      const next = nextMessagesToEmbed()
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${next.sql}`, [650, ...next.params])
      plan = rows.map((r) => r['QUERY PLAN']).join('\n')
    })

    it('should walk the eligible-messages index', () => {
      expect(plan).toContain('idx_messages_embedding_eligible')
    })

    it('should not sort the candidates', () => {
      expect(plan).not.toMatch(/\bSort\b/)
    })
  })
})
