// The automated flag through every real writer, against real PostgreSQL (#177).
//
// Each writer stores a session, and the flag it lands with must be what the
// classifier says about that session's opening text. Unit tests mock the
// classification query, so only a real database can catch the query itself
// reading the wrong text: the title of a transcript, an assistant line, a
// memory's body.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PG, applyInitDb, createScratchDatabase, dbAvailable } from '../__tests__/scratch-database.js'
import { config } from '../config.js'
// The writers load only when there is a database to write to. A skipped suite
// that imported them anyway would load modules it never calls, and coverage
// counts every function of a loaded module.
const loadWriters = async () => {
  const { closePool, query, queries } = await import('../db/postgres.js')
  const { syncSession } = await import('../sync/claude-code.js')
  const { syncClaudeMemories } = await import('../sync/claude-memory.js')
  const { ingestConversation } = await import('../mcp/ingest.js')
  const { IngestPayloadSchema } = await import('../mcp/ingest-schema.js')
  const { writeNote } = await import('../mcp/notes.js')
  const { correctAutomatedDrift, findAutomatedDrift, flagAutomated } = await import('./automated-flags.js')
  return { closePool, query, queries, syncSession, syncClaudeMemories, ingestConversation, IngestPayloadSchema, writeNote, correctAutomatedDrift, findAutomatedDrift, flagAutomated }
}
const w = dbAvailable ? await loadWriters() : (undefined as unknown as Awaited<ReturnType<typeof loadWriters>>)

const PROMPT = 'Night-shift lair report:'
const MEMORY_TITLE = 'Memory: lair-night-log'
const configure = (prefixes: string[]) => Object.assign(config.automated, { prefixes })

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
let memoryRoot: string

const message = (uuid: string, sequenceNum: number, role: 'user' | 'assistant', contentText: string) => ({
  uuid,
  parentUuid: null,
  role,
  contentText,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, sequenceNum)),
  sequenceNum,
  isSidechain: false,
})

const transcript = (sessionId: string, messages: ReturnType<typeof message>[]) => ({
  sessionId,
  filePath: `/srv/lair/${sessionId}.jsonl`,
  fileModifiedAt: new Date('2026-01-01T01:00:00Z'),
  isAgent: false,
  messages,
  firstTimestamp: messages[0].timestamp,
  lastTimestamp: messages.at(-1)!.timestamp,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  badLines: [],
  lineNumbers: new Map(messages.map((m, i) => [m.uuid, i + 1])),
})

const syncTranscript = async (sourceName: string, sessionId: string, messages: ReturnType<typeof message>[]) => {
  const source = await w.queries.getSourceByName(sourceName)
  const projectId = await w.queries.upsertProject(source!.id, `${sourceName}-lair`, '/srv/lair', 'lair')
  const result = await w.syncSession(source!.id, projectId, transcript(sessionId, messages) as never, sourceName)
  expect(result.errors).toEqual([])
}

const ingest = (mode: 'append' | 'snapshot', externalId: string, title: string, firstLine: string) =>
  w.ingestConversation(
    w.IngestPayloadSchema.parse({
      ...(mode === 'snapshot' ? { mode, snapshot: { revision: 1, complete: true } } : {}),
      source: `lair-${mode}`,
      dataClass: 'personal',
      project: { externalId: 'lair-thread', name: 'lair' },
      session: { externalId, title, startedAt: '2026-01-01T00:00:00Z' },
      messages: [{ externalId: `${externalId}-1`, role: 'user', content: firstLine, timestamp: '2026-01-01T00:00:00Z', sequenceNum: 0 }],
    })
  )

const flags = async () =>
  Object.fromEntries(
    (
      await w.query<{ external_id: string; is_automated: boolean }>(
        `SELECT s.external_id, s.is_automated FROM sessions s WHERE s.deleted_at IS NULL ORDER BY s.external_id`
      )
    ).rows.map((r) => [r.external_id.replace(/^snapshot:.*$/, 'snapshot'), r.is_automated])
  )

beforeAll(async () => {
  if (!dbAvailable) return
  scratch = await createScratchDatabase('mm_test_autoflag')
  await applyInitDb(scratch.name)
  Object.assign(config.postgres, { ...PG, database: scratch.name })

  memoryRoot = await mkdtemp(join(tmpdir(), 'mm-autoflag-'))
  const memoryDir = join(memoryRoot, 'projects', '-srv-lair', 'memory')
  await mkdir(memoryDir, { recursive: true })
  await writeFile(join(memoryDir, 'lair-night-log.md'), '---\nname: lair-night-log\ndescription: x\n---\nquiet night\n')
  await writeFile(join(memoryDir, 'lantern.md'), `---\nname: lantern\ndescription: x\n---\n${PROMPT} quoted in a memory\n`)
  Object.assign(config.sources.claudeCode, { path: memoryRoot })

  configure([PROMPT, MEMORY_TITLE])
  await syncTranscript('claude_code', 'prompted', [message('u1', 0, 'user', `${PROMPT} all quiet`)])
  await syncTranscript('claude_code', 'assistant-says-it', [
    message('a1', 0, 'assistant', `${PROMPT} from the assistant`),
    message('u1', 1, 'user', 'Fix the lantern'),
  ])
  await syncTranscript('claude_code', 'empty-opener', [
    message('u1', 0, 'user', ''),
    message('u2', 1, 'user', `${PROMPT} inside a tool result`),
  ])
  await syncTranscript('codex', 'codex-prompted', [message('u1', 0, 'user', `${PROMPT} from codex`)])
  const memories = await w.syncClaudeMemories()
  expect(memories.errors).toEqual([])
  await ingest('append', 'thread-titled', `${PROMPT} thread`, 'hello')
  await ingest('append', 'thread-quoting', 'Weekly lair sync', `${PROMPT} quoted`)
  await ingest('snapshot', 'thread-snapshot', `${PROMPT} snapshot`, 'hello')
  await w.writeNote({ text: 'remember the lantern', title: `${PROMPT} note` })
}, 180_000)

afterAll(async () => {
  configure([])
  await w?.closePool().catch(() => {})
  await scratch?.drop()
  if (memoryRoot) await rm(memoryRoot, { recursive: true, force: true })
}, 60_000)

describe.skipIf(!dbAvailable)('the automated flag as every writer stores it (scratch database)', () => {
  it('flags each session by its own kind of opening text, and leaves nothing for the correction to change', async () => {
    const stored = await flags()
    const note = Object.keys(stored).find((id) => id.startsWith('note-'))!
    expect(stored).toEqual({
      prompted: true,
      'assistant-says-it': false,
      'empty-opener': false,
      'codex-prompted': true,
      'memory:lair-night-log': true,
      'memory:lantern': false,
      'thread-titled': true,
      'thread-quoting': false,
      snapshot: true,
      [note]: true,
    })
    expect(await w.findAutomatedDrift()).toEqual([])
  })

  // The defect itself: a session written before its prefix was configured.
  it('flags a session whose file never changes again once its prefix is configured', async () => {
    configure([])
    await syncTranscript('claude_code', 'written-before', [message('u1', 0, 'user', 'Lair census: 3 bats')])
    configure([PROMPT, MEMORY_TITLE, 'Lair census:'])

    expect(await w.flagAutomated()).toBe(1)
    expect((await flags())['written-before']).toBe(true)
    expect(await w.flagAutomated()).toBe(0)
  })

  // A container recreated without the variable must not undo what a configured
  // one set, or the two would trade ~800 flags every run.
  it('changes no flag when run with an empty prefix list, from sync or from a re-synced file', async () => {
    const before = await flags()
    configure([])

    expect(await w.flagAutomated()).toBe(0)
    await syncTranscript('claude_code', 'prompted', [
      message('u1', 0, 'user', `${PROMPT} all quiet`),
      message('a1', 1, 'assistant', 'noted'),
    ])

    expect(await flags()).toEqual(before)
  })

  it('clears only through the explicit correction, and a repeated correction changes nothing', async () => {
    configure([])
    const drift = await w.findAutomatedDrift()
    expect(drift.every((d) => d.stored)).toBe(true)
    expect(drift.length).toBeGreaterThan(0)

    expect(await w.correctAutomatedDrift(drift)).toBe(drift.length)
    expect(await w.correctAutomatedDrift(drift)).toBe(0)
    expect(Object.values(await flags()).every((flag) => !flag)).toBe(true)
  })
})
