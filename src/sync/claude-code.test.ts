import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const {
  getSourceByName,
  upsertProject,
  getSessionByExternalId,
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

const { syncSession, discoverSessionFiles, syncClaudeCode } = await import('./claude-code.js')
const { config } = await import('../config.js')

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

beforeEach(() => {
  getSourceByName.mockReset().mockResolvedValue({ id: 1 })
  upsertProject.mockReset().mockResolvedValue(10)
  getSessionByExternalId.mockReset().mockResolvedValue(null)
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

    // Only the initial upsert — the agent's worktree cwd must never reach
    // upsertProject. The stored path is the raw directory name (an honest
    // "unknown"), never the lossy decode (#33).
    expect(upsertProject).toHaveBeenCalledTimes(1)
    expect(upsertProject).toHaveBeenCalledWith(1, '-home-u-proj', '-home-u-proj', 'proj')
  })

  // A transcript can carry a cwd that is NOT this project's directory — a
  // worktree's transcript recording the parent repo, for instance. Re-encoding
  // the cwd must reproduce the directory name before it may rename the row.
  it('ignores a cwd that does not re-encode to the project directory name', async () => {
    const { base, project } = await claudeBase('-home-u-proj--claude-worktrees-agent-x')
    await writeFile(join(project, 'sess-1.jsonl'), transcriptLine({ cwd: '/home/u/proj' }) + '\n')
    ;(config.sources.claudeCode as { path: string }).path = base

    await syncClaudeCode()

    expect(upsertProject).toHaveBeenCalledTimes(1)
    expect(upsertProject).toHaveBeenCalledWith(
      1,
      '-home-u-proj--claude-worktrees-agent-x',
      '-home-u-proj--claude-worktrees-agent-x',
      'x'
    )
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
