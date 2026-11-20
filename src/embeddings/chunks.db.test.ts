// Two workers summarizing the same session at once, against real PostgreSQL.
// Both clear the session's old chunks, then both spend minutes in the model,
// then both write chunk 0. The session_chunks upsert hands the second worker
// the same row id, so its embeddings write lands on a (session_chunk_id,
// chroma_collection) pair that already exists.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { PG, applyInitDb, createScratchDatabase, dbAvailable } from '../__tests__/scratch-database.js'
import { config } from '../config.js'
import { closePool, query } from '../db/postgres.js'
import { CHUNK_SIZE_CHARS } from './summarize.js'
import { persistSessionChunks } from './chunks.js'

vi.mock('../db/chroma.js', () => ({
  upsertEmbeddings: vi.fn(async () => {}),
  deleteByIds: vi.fn(async () => {}),
}))
vi.mock('./ollama.js', () => ({
  generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
}))

const SUMMARY = 'Thunderwrench HVAC Co. rewired the lair. '.repeat(5)

// Holds the first two summaries until both workers are inside one, so both
// have already cleared the old chunks before either writes a new one.
const waiting: (() => void)[] = []
vi.mock('./summarize.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./summarize.js')>()),
  summarizeSessionChunk: async () => {
    if (waiting.length >= 2) return SUMMARY
    await new Promise<void>((release) => {
      waiting.push(release)
      if (waiting.length === 2) waiting.forEach((r) => r())
    })
    return SUMMARY
  },
}))

describe.skipIf(!dbAvailable)('persistSessionChunks', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let sessionId: number

  beforeAll(async () => {
    scratch = await createScratchDatabase('chunk_race')
    await applyInitDb(scratch.name)
    Object.assign(config.postgres, { ...PG, database: scratch.name })
    const { rows } = await query<{ id: number }>(`
      WITH src AS (
        INSERT INTO sources (name, display_name) VALUES ('source-lair', 'The Lair') RETURNING id
      ), proj AS (
        INSERT INTO projects (source_id, external_id) SELECT id, 'project-rusty-conquistador' FROM src RETURNING id
      )
      INSERT INTO sessions (project_id, external_id) SELECT id, 'session-valley-of-the-sun' FROM proj RETURNING id`)
    sessionId = rows[0].id
  }, 120_000)

  afterAll(async () => {
    await closePool()
    await scratch?.drop()
  })

  describe('when two workers summarize the same session at once', () => {
    let outcomes: PromiseSettledResult<unknown>[]

    beforeAll(async () => {
      const big = 'x'.repeat(CHUNK_SIZE_CHARS - 20)
      const messages = [
        { id: 1, role: 'user', content_text: big },
        { id: 2, role: 'assistant', content_text: big },
      ]
      outcomes = await Promise.allSettled([persistSessionChunks(sessionId, messages), persistSessionChunks(sessionId, messages)])
    })

    it('should keep both workers summaries', () => {
      expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled'])
    })

    it('should leave one embedding row per chunk', async () => {
      const { rows } = await query<{ chunk_index: number }>(
        `SELECT c.chunk_index FROM embeddings e JOIN session_chunks c ON c.id = e.session_chunk_id
         WHERE c.session_id = $1 ORDER BY c.chunk_index`,
        [sessionId]
      )
      expect(rows.map((r) => r.chunk_index)).toEqual([0, 1, 2])
    })
  })
})
