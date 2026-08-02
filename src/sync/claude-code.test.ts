import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const {
  getSourceByName,
  upsertProject,
  getSessionByExternalId,
  getLiveSessionByExternalId,
  upsertSession,
  insertMessage,
  updateSessionStats,
  updateSessionContentChars,
  updateSyncState,
  quarantineMock,
} = vi.hoisted(() => ({
  getSourceByName: vi.fn(),
  upsertProject: vi.fn(),
  getSessionByExternalId: vi.fn(),
  getLiveSessionByExternalId: vi.fn(),
  upsertSession: vi.fn(),
  insertMessage: vi.fn(),
  updateSessionStats: vi.fn(),
  updateSessionContentChars: vi.fn(),
  updateSyncState: vi.fn(),
  quarantineMock: vi.fn(),
}))

vi.mock('../db/postgres.js', () => ({
  query: vi.fn(),
  queries: {
    getSourceByName,
    upsertProject,
    getSessionByExternalId,
    getLiveSessionByExternalId,
    upsertSession,
    insertMessage,
    updateSessionStats,
    updateSessionContentChars,
    updateSyncState,
  },
}))
vi.mock('./quarantine.js', () => ({ quarantine: quarantineMock }))
vi.mock('../config.js', () => ({
  config: { machine: 'test-box', sources: { claudeCode: { path: '/nope' } } },
}))

const { syncSession, discoverSessionFiles, syncClaudeCode, parentExternalIdFromRawPath } =
  await import('./claude-code.js')
const { config } = await import('../config.js')

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

beforeEach(() => {
  getSourceByName.mockReset().mockResolvedValue({ id: 1 })
  upsertProject.mockReset().mockResolvedValue(10)
  getSessionByExternalId.mockReset().mockResolvedValue(null)
  getLiveSessionByExternalId.mockReset().mockResolvedValue(null)
  upsertSession.mockReset().mockResolvedValue(77)
  insertMessage.mockReset().mockResolvedValue(1)
  updateSessionStats.mockReset().mockResolvedValue(undefined)
  updateSessionContentChars.mockReset().mockResolvedValue(undefined)
  updateSyncState.mockReset().mockResolvedValue(undefined)
  quarantineMock.mockReset().mockResolvedValue(1)
})

const msg = (uuid: string, sequenceNum: number) => ({
  uuid,
  parentUuid: null,
  role: 'user' as const,
  contentText: `content of ${uuid}`,
  timestamp: new Date('2026-01-01T00:00:00Z'),
  sequenceNum,
  isSidechain: false,
})

const session = (over: Record<string, unknown> = {}) => ({
  sessionId: 'sess-1',
  filePath: '/p/sess-1.jsonl',
  fileModifiedAt: new Date('2026-01-01T00:00:00Z'),
  isAgent: false,
  messages: [msg('u1', 0), msg('u2', 1)],
  firstTimestamp: new Date('2026-01-01T00:00:00Z'),
  lastTimestamp: new Date('2026-01-01T00:01:00Z'),
  totalInputTokens: 0,
  totalOutputTokens: 0,
  badLines: [],
  lineNumbers: new Map([
    ['u1', 1],
    ['u2', 2],
  ]),
  ...over,
})

describe('syncSession', () => {
  it('inserts every message on the happy path, nothing quarantined', async () => {
    const result = await syncSession(1, 3, session() as never)
    expect(result).toEqual({ messagesInserted: 2, quarantined: 0, errors: [] })
    expect(quarantineMock).not.toHaveBeenCalled()
    expect(updateSessionStats).toHaveBeenCalledWith(77)
  })

  // The one insert per-message quarantine cannot protect. Before this guard,
  // a failing session upsert threw the whole file with nothing preserved —
  // which is exactly how issue #20's live failure bypassed the quarantine.
  it('quarantines every record when the session upsert itself fails', async () => {
    upsertSession.mockRejectedValueOnce(new Error('invalid byte sequence for encoding "UTF8": 0x00'))

    const result = await syncSession(1, 3, session() as never)

    expect(result).toEqual({ messagesInserted: 0, quarantined: 2, errors: [] })
    expect(quarantineMock).toHaveBeenCalledTimes(2)
    // No session row exists, so records carry the external id + project and
    // resolve on replay.
    expect(quarantineMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionExternalId: 'sess-1',
        projectId: 3,
        recordKey: 'uuid:u1',
        stage: 'insert',
      })
    )
    expect(quarantineMock.mock.calls.every(c => c[0].sessionId === undefined)).toBe(true)
    expect(insertMessage).not.toHaveBeenCalled()
    expect(updateSessionStats).not.toHaveBeenCalled()
  })

  it('quarantines a failing message and keeps the rest of the conversation', async () => {
    insertMessage.mockRejectedValueOnce(new Error('boom'))

    const result = await syncSession(1, 3, session() as never)

    expect(result).toEqual({ messagesInserted: 1, quarantined: 1, errors: [] })
    expect(quarantineMock).toHaveBeenCalledWith(
      expect.objectContaining({ recordKey: 'uuid:u1', sessionId: 77, stage: 'insert' })
    )
  })

  // quarantine() returning null means the preserving write itself failed.
  // That is a loss, and it must surface as an error — never be counted as
  // saved, never let /status claim "data is waiting" for data that is gone.
  it('reports an error instead of counting a failed quarantine write as saved', async () => {
    insertMessage.mockRejectedValueOnce(new Error('boom'))
    quarantineMock.mockResolvedValueOnce(null)

    const result = await syncSession(1, 3, session() as never)

    expect(result.quarantined).toBe(0)
    expect(result.messagesInserted).toBe(1)
    expect(result.errors).toEqual([
      'Quarantine write failed for /p/sess-1.jsonl#uuid:u1 — record NOT preserved',
    ])
  })

  it('reports every loss when quarantine fails during a session-upsert failure', async () => {
    upsertSession.mockRejectedValueOnce(new Error('nope'))
    quarantineMock.mockResolvedValue(null)

    const result = await syncSession(1, 3, session() as never)

    expect(result.quarantined).toBe(0)
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toContain('NOT preserved')
  })

  it('quarantines unreadable lines against the session row', async () => {
    const result = await syncSession(
      1,
      3,
      session({ badLines: [{ lineNumber: 9, raw: '{"broken', error: 'Unexpected end' }] }) as never
    )

    expect(result.quarantined).toBe(1)
    expect(quarantineMock).toHaveBeenCalledWith(
      expect.objectContaining({ recordKey: 'line:9', sessionId: 77, stage: 'parse', payload: '{"broken' })
    )
  })
})

// #48: subagent transcripts landed with parent_session_id NULL — 188 of 188
// on the reference machine. The parser has always computed the parent's
// external id (`sessionId` from inside the file, which is the spawning
// conversation, never the agent's own filename-derived id); sync just never
// resolved it to a row id or passed it on.
describe('syncSession parent linkage', () => {
  const agentSession = (over: Record<string, unknown> = {}) =>
    session({
      sessionId: 'agent-abc',
      isAgent: true,
      agentId: 'abc',
      parentSessionId: 'sess-1',
      filePath: '/p/sess-1/subagents/agent-abc.jsonl',
      ...over,
    })

  it('resolves the parent external id to a row id and passes it to upsertSession', async () => {
    getLiveSessionByExternalId.mockResolvedValue({ id: 55 })

    await syncSession(1, 3, agentSession() as never)

    expect(getLiveSessionByExternalId).toHaveBeenCalledWith(3, 'sess-1')
    expect(upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: 'agent-abc', isAgent: true, parentSessionId: 55 })
    )
  })

  // The link is upward to the *spawning* conversation. A regression that
  // passed the session's own row id would look like linkage and navigate
  // nowhere, so assert the two are distinct.
  it('never links a subagent to itself', async () => {
    getLiveSessionByExternalId.mockResolvedValue({ id: 55 })
    upsertSession.mockResolvedValue(77)

    await syncSession(1, 3, agentSession() as never)

    const [params] = upsertSession.mock.calls[0]
    expect(params.parentSessionId).toBe(55)
    expect(params.parentSessionId).not.toBe(77)
  })

  // Discovery can reach a subagent before its parent is indexed. That must
  // cost the link for this run, not the session.
  it('indexes the session with a null parent when the parent is not indexed yet', async () => {
    getLiveSessionByExternalId.mockResolvedValue(null)

    const result = await syncSession(1, 3, agentSession() as never)

    expect(result.messagesInserted).toBe(2)
    expect(upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ parentSessionId: undefined })
    )
  })

  it('does not look up a parent for an ordinary top-level session', async () => {
    await syncSession(1, 3, session() as never)

    expect(getLiveSessionByExternalId).not.toHaveBeenCalled()
    expect(upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ parentSessionId: undefined })
    )
  })
})

// Rows that predate the linkage fix are skipped forever by incremental sync
// (unchanged mtime), so they can only be repaired from stored data. The one
// stored field that carries the parent is raw_file_path. Verified against the
// transcripts on disk: this agrees with the in-file sessionId sync itself uses
// on 203 of 204 subagent files (the exception has no sessionId at all).
describe('parentExternalIdFromRawPath', () => {
  it('reads the parent from the segment above subagents/', () => {
    expect(parentExternalIdFromRawPath('/root/.claude/projects/-p/sess-1/subagents/agent-a.jsonl'))
      .toBe('sess-1')
  })

  // Claude Code groups some subagents under an extra workflow directory. The
  // parent is still the segment above subagents/, not the workflow folder.
  it('is not confused by workflow subdirectories under subagents/', () => {
    expect(
      parentExternalIdFromRawPath('/root/.claude/projects/-p/sess-1/subagents/workflows/wf_x/agent-a.jsonl')
    ).toBe('sess-1')
  })

  // Agents can spawn agents, and this function cannot tell what such a
  // transcript records as its parent: live sync reads the in-file sessionId,
  // and there is no evidence it names the spawning *agent* rather than the
  // root conversation. Zero doubly-nested transcripts exist to check against
  // (verified across all 210 subagent transcripts on this host), so the
  // honest answer is to decline rather than write a guess into a link that a
  // reader will traverse (#48 review, finding 5).
  it('refuses to guess a parent for a doubly-nested transcript', () => {
    expect(
      parentExternalIdFromRawPath('/root/.claude/projects/-p/sess-1/subagents/agent-a/subagents/agent-b.jsonl')
    ).toBeNull()
  })

  it('handles Windows-style separators, since rows come from several machines', () => {
    expect(parentExternalIdFromRawPath('D:\\c\\projects\\-p\\sess-1\\subagents\\agent-a.jsonl'))
      .toBe('sess-1')
  })

  it('returns null for a path with no subagents/ segment and for no path at all', () => {
    expect(parentExternalIdFromRawPath('/root/.claude/projects/-p/sess-1.jsonl')).toBeNull()
    expect(parentExternalIdFromRawPath(null)).toBeNull()
    expect(parentExternalIdFromRawPath('/subagents/agent-a.jsonl')).toBeNull()
  })
})

describe('discoverSessionFiles', () => {
  // Newer Claude Code stores subagent transcripts in nested directories
  // (`<sessionId>/subagents/agent-*.jsonl`, deeper when agents spawn agents).
  // A top-level-only walk silently missed all of them — on one machine, 161
  // of 193 session files. Discovery has to be recursive.
  it('finds session files at every depth, not just the project root', async () => {
    const project = await mkdtemp(join(tmpdir(), 'mindmeld-project-'))
    dirs.push(project)

    await writeFile(join(project, 'top-level.jsonl'), '{}\n')
    await mkdir(join(project, 'sess-1', 'subagents'), { recursive: true })
    await writeFile(join(project, 'sess-1', 'subagents', 'agent-abc.jsonl'), '{}\n')
    await mkdir(join(project, 'sess-1', 'subagents', 'agent-abc', 'subagents'), {
      recursive: true,
    })
    await writeFile(
      join(project, 'sess-1', 'subagents', 'agent-abc', 'subagents', 'agent-def.jsonl'),
      '{}\n'
    )
    await writeFile(join(project, 'not-a-session.txt'), 'ignore me\n')

    const discovered = await discoverSessionFiles(project)

    expect(discovered.errors).toEqual([])
    expect(discovered.files.sort()).toEqual(
      [
        join(project, 'top-level.jsonl'),
        join(project, 'sess-1', 'subagents', 'agent-abc.jsonl'),
        join(project, 'sess-1', 'subagents', 'agent-abc', 'subagents', 'agent-def.jsonl'),
      ].sort()
    )
  })

  // A walk failure must be an error the caller can count toward the exit
  // code, not a console line and a silently shorter file list.
  it('reports an unreadable directory as an error instead of throwing', async () => {
    const discovered = await discoverSessionFiles('/does/not/exist')
    expect(discovered.files).toEqual([])
    expect(discovered.errors).toHaveLength(1)
    expect(discovered.errors[0]).toContain('/does/not/exist')
  })
})

// A line a real transcript would carry.
const transcriptLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    uuid: `u-${Math.random().toString(36).slice(2)}`,
    parentUuid: null,
    sessionId: 'sess-1',
    timestamp: '2026-07-01T00:00:00Z',
    message: { role: 'user', content: 'hello' },
    ...over,
  })

// Build a fake ~/.claude with one encoded project directory.
async function claudeBase(encodedProject: string): Promise<{ base: string; project: string }> {
  const base = await mkdtemp(join(tmpdir(), 'mindmeld-claude-'))
  dirs.push(base)
  const project = join(base, 'projects', encodedProject)
  await mkdir(project, { recursive: true })
  return { base, project }
}

// The walk is depth-first and `<sessionId>/` sorts before `<sessionId>.jsonl`,
// so in file order a subagent is reached before the conversation that spawned
// it — the parent row does not exist yet and the lookup returns nothing.
// Resolving the parent is not enough on its own; parents have to be synced
// first.
describe('syncClaudeCode parent linkage ordering', () => {
  it('syncs the parent conversation before its subagents so the link resolves', async () => {
    const { base, project } = await claudeBase('-home-u-proj')
    await writeFile(join(project, 'sess-1.jsonl'), transcriptLine({ cwd: '/home/u/proj' }) + '\n')
    await mkdir(join(project, 'sess-1', 'subagents'), { recursive: true })
    await writeFile(
      join(project, 'sess-1', 'subagents', 'agent-abc.jsonl'),
      transcriptLine({
        sessionId: 'sess-1',
        isSidechain: true,
        cwd: '/home/u/proj/.claude/worktrees/agent-abc',
      }) + '\n'
    )
    ;(config.sources.claudeCode as { path: string }).path = base

    // A row exists only once it has actually been upserted — the same
    // constraint the real database imposes on a single sync run.
    const rows = new Map<string, number>()
    getSessionByExternalId.mockImplementation(async (_projectId: number, externalId: string) =>
      rows.has(externalId)
        ? { id: rows.get(externalId), file_modified_at: null, content_chars: 0, message_count: 0 }
        : null
    )
    upsertSession.mockImplementation(async (params: { externalId: string }) => {
      const id = 100 + rows.size
      rows.set(params.externalId, id)
      return id
    })

    await syncClaudeCode()

    const order = upsertSession.mock.calls.map((c) => c[0].externalId)
    expect(order).toEqual(['sess-1', 'agent-abc'])

    const agentCall = upsertSession.mock.calls.find((c) => c[0].externalId === 'agent-abc')![0]
    expect(agentCall.parentSessionId).toBe(rows.get('sess-1'))
    expect(agentCall.parentSessionId).not.toBe(rows.get('agent-abc'))
  })
})

describe('syncClaudeCode cwd correction', () => {
  // Subagent transcripts carry their isolated worktree as cwd
  // (.claude/worktrees/agent-*). On an incremental run the freshest file is
  // often the only one parsed, so if agent sessions could drive the cwd
  // correction, a project row would flip its path and name to agent-xxx.
  it('never lets a subagent transcript rewrite the project path', async () => {
    const { base, project } = await claudeBase('-home-u-proj')
    await mkdir(join(project, 'sess-1', 'subagents'), { recursive: true })
    await writeFile(
      join(project, 'sess-1', 'subagents', 'agent-abc.jsonl'),
      transcriptLine({ cwd: '/home/u/proj/.claude/worktrees/agent-abc' }) + '\n'
    )
    ;(config.sources.claudeCode as { path: string }).path = base

    await syncClaudeCode()

    // Only the initial upsert from the decoded directory name — the agent's
    // worktree cwd must never reach upsertProject.
    expect(upsertProject).toHaveBeenCalledTimes(1)
    expect(upsertProject).toHaveBeenCalledWith(1, '-home-u-proj', '/home/u/proj', 'proj')
  })

  it('still corrects the project path from a main session cwd', async () => {
    const { base, project } = await claudeBase('-home-u-my-proj')
    await writeFile(
      join(project, 'sess-1.jsonl'),
      transcriptLine({ cwd: '/home/u/my-proj' }) + '\n'
    )
    ;(config.sources.claudeCode as { path: string }).path = base

    await syncClaudeCode()

    // decodeProjectPath is lossy ('-' becomes '/'), so the session cwd is the
    // truth: the second upsert carries it.
    expect(upsertProject).toHaveBeenCalledTimes(2)
    expect(upsertProject).toHaveBeenLastCalledWith(
      1,
      '-home-u-my-proj',
      '/home/u/my-proj',
      'my-proj'
    )
  })
})
