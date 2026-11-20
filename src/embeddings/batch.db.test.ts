// Two workers draining the same session queue, against real PostgreSQL. Each
// selects the same pending sessions before either starts, and a session is
// minutes of GPU, so whatever one worker is summarizing the other must skip.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { PG, applyInitDb, createScratchDatabase, dbAvailable } from '../__tests__/scratch-database.js'
import { config } from '../config.js'
import { closePool, query } from '../db/postgres.js'
import { updateAggregateEmbeddings } from './batch.js'

vi.mock('../db/chroma.js', () => ({
  addEmbeddings: vi.fn(),
  upsertEmbeddings: vi.fn(async () => {}),
  getEmbeddingMetadata: vi.fn(async () => null),
  getCollection: vi.fn(),
}))
vi.mock('./ollama.js', () => ({
  generateEmbeddings: vi.fn(async () => [[0.1, 0.2]]),
  ensureEmbeddingModel: vi.fn(),
}))

const summarized: string[] = []
let firstInside: () => void
let releaseFirst: () => void
const firstEntered = new Promise<void>((resolve) => (firstInside = resolve))
const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve))

vi.mock('./summarize.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./summarize.js')>()),
  ensureSummarizeModel: vi.fn(),
  generateTitle: vi.fn(async () => null),
  summarizeConversation: async (messages: string[]) => {
    summarized.push(messages.join(''))
    if (summarized.length === 1) {
      firstInside()
      await firstReleased
    }
    return 'Thunderwrench HVAC Co. replaced the furnace blower in the lair.'
  },
}))

describe.skipIf(!dbAvailable)('updateAggregateEmbeddings', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>

  beforeAll(async () => {
    scratch = await createScratchDatabase('session_claim')
    await applyInitDb(scratch.name)
    Object.assign(config.postgres, { ...PG, database: scratch.name })
    await query(`
      WITH src AS (
        INSERT INTO sources (name, display_name) VALUES ('source-lair', 'The Lair') RETURNING id
      ), proj AS (
        INSERT INTO projects (source_id, external_id) SELECT id, 'project-rusty-conquistador' FROM src RETURNING id
      ), sess AS (
        INSERT INTO sessions (project_id, external_id, message_count, started_at)
        SELECT proj.id, 'session-' || name, 1, TIMESTAMPTZ '2026-01-01' + hour * INTERVAL '1 hour'
        FROM proj, unnest(ARRAY['valley-of-the-sun', 'gnome-depot']) WITH ORDINALITY AS t(name, hour)
        RETURNING id, external_id
      )
      INSERT INTO messages (session_id, external_id, role, content_text, timestamp, sequence_num)
      SELECT id, 'message-' || external_id, 'user', 'Furnace report for ' || external_id, TIMESTAMPTZ '2026-01-01', 0 FROM sess`)
  }, 120_000)

  afterAll(async () => {
    await closePool()
    await scratch?.drop()
  })

  describe('when a second worker runs while the first is summarizing', () => {
    beforeAll(async () => {
      const first = updateAggregateEmbeddings(Infinity)
      await firstEntered
      await updateAggregateEmbeddings(Infinity)
      releaseFirst()
      await first
    }, 60_000)

    it('should summarize each session once', () => {
      expect(summarized.map((text) => text.replace(/^.*Furnace report for /, '')).sort()).toEqual([
        'session-gnome-depot',
        'session-valley-of-the-sun',
      ])
    })

    it('should leave no session claimed', async () => {
      const { rows } = await query(`SELECT objid FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
      expect(rows).toEqual([])
    })
  })
})
