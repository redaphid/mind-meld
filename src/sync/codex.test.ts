import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { getSourceByName, getSessionByExternalIdGlobal, upsertProject, updateSyncState, syncSession } =
  vi.hoisted(() => ({
    getSourceByName: vi.fn(),
    getSessionByExternalIdGlobal: vi.fn(),
    upsertProject: vi.fn(),
    updateSyncState: vi.fn(),
    syncSession: vi.fn(),
  }));

vi.mock('../db/postgres.js', () => ({
  queries: { getSourceByName, getSessionByExternalIdGlobal, upsertProject, updateSyncState },
}));
vi.mock('../config.js', () => ({ config: { sources: { codex: { path: '/nope' } } } }));
vi.mock('./claude-code.js', () => ({ syncSession }));

const { discoverCodexSessions, syncCodex } = await import('./codex.js');
const { config } = await import('../config.js');
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  getSourceByName.mockReset().mockResolvedValue({ id: 2 });
  getSessionByExternalIdGlobal.mockReset().mockResolvedValue(null);
  upsertProject.mockReset().mockResolvedValue(44);
  updateSyncState.mockReset().mockResolvedValue(undefined);
  syncSession.mockReset().mockResolvedValue({ messagesInserted: 1, quarantined: 0, errors: [] });
});

const line = (payload: object, ordinal = 0) => JSON.stringify({
  type: ordinal === 0 ? 'session_meta' : 'response_item',
  payload,
  ordinal,
  timestamp: `2026-01-01T00:00:0${ordinal}Z`,
});

const writeSession = async (path: string, meta: object) => {
  await writeFile(path, [
    line(meta),
    line({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }, 1),
  ].join('\n'));
};

describe('discoverCodexSessions', () => {
  it('finds active and archived rollouts recursively', async () => {
    const base = await mkdtemp(join(tmpdir(), 'codex-sync-'));
    dirs.push(base);
    await mkdir(join(base, 'sessions', '2026', '01'), { recursive: true });
    await mkdir(join(base, 'archived_sessions'), { recursive: true });
    await writeFile(join(base, 'sessions', '2026', '01', 'active.jsonl'), '{}');
    await writeFile(join(base, 'archived_sessions', 'old.jsonl'), '{}');

    const found = await discoverCodexSessions(base);
    expect(found.errors).toEqual([]);
    expect(found.files).toHaveLength(2);
  });

  it('treats absent optional roots as empty and reports unreadable paths', async () => {
    const base = await mkdtemp(join(tmpdir(), 'codex-sync-'));
    dirs.push(base);
    expect(await discoverCodexSessions(base)).toEqual({ files: [], errors: [] });
    const missingBase = join(base, 'missing');
    const found = await discoverCodexSessions(missingBase);
    expect(found.errors).toEqual([]);
  });
});

describe('syncCodex', () => {
  it('indexes parents before subagents and keeps subagents in the parent project', async () => {
    const base = await mkdtemp(join(tmpdir(), 'codex-sync-'));
    dirs.push(base);
    const sessions = join(base, 'sessions', '2026', '01');
    await mkdir(sessions, { recursive: true });
    await writeSession(join(sessions, 'rollout-2026-01-01T00-00-00-parent.jsonl'), {
      id: 'parent', cwd: '/home/test/project', thread_source: 'user',
    });
    await writeSession(join(sessions, 'rollout-2026-01-01T00-01-00-child.jsonl'), {
      id: 'child', cwd: '/home/test/worktree', thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } },
    });
    (config.sources.codex as { path: string }).path = base;
    getSessionByExternalIdGlobal.mockImplementation(async (_source: number, id: string) =>
      id === 'parent' && syncSession.mock.calls.length > 0 ? { project_id: 44 } : null
    );

    const result = await syncCodex({ incremental: false });

    expect(result).toMatchObject({ projectsProcessed: 1, sessionsProcessed: 2, messagesInserted: 2 });
    expect(syncSession.mock.calls.map((call) => call[2].sessionId)).toEqual(['parent', 'child']);
    expect(syncSession.mock.calls[1][1]).toBe(44);
    expect(syncSession.mock.calls[1][3]).toBe('codex');
  });

  it('fails visibly when the source migration is missing', async () => {
    getSourceByName.mockResolvedValueOnce(null);
    expect(await syncCodex()).toMatchObject({
      sessionsProcessed: 0,
      errors: ['Codex source not found in database'],
    });
  });

  it('skips an unchanged session during incremental sync', async () => {
    const base = await mkdtemp(join(tmpdir(), 'codex-sync-'));
    dirs.push(base);
    const sessions = join(base, 'sessions');
    await mkdir(sessions, { recursive: true });
    const file = join(sessions, 'rollout.jsonl');
    await writeSession(file, { id: 'same', cwd: '/home/test/project' });
    const modified = (await import('node:fs/promises')).stat(file);
    getSessionByExternalIdGlobal.mockResolvedValue({ file_modified_at: (await modified).mtime });
    (config.sources.codex as { path: string }).path = base;

    expect(await syncCodex({ incremental: true })).toMatchObject({ skipped: 1, sessionsProcessed: 0 });
    expect(syncSession).not.toHaveBeenCalled();
  });

  it('indexes a changed session with unknown project metadata and carries writer errors', async () => {
    const base = await mkdtemp(join(tmpdir(), 'codex-sync-'));
    dirs.push(base);
    await mkdir(join(base, 'sessions'), { recursive: true });
    await writeSession(join(base, 'sessions', 'unknown.jsonl'), { id: 'unknown' });
    (config.sources.codex as { path: string }).path = base;
    getSessionByExternalIdGlobal.mockResolvedValue({ file_modified_at: null });
    syncSession.mockResolvedValueOnce({
      messagesInserted: 0, quarantined: 2, errors: ['one record was not preserved'],
    });

    const result = await syncCodex({ incremental: true });
    expect(result).toMatchObject({ sessionsProcessed: 1, quarantined: 2, errors: ['one record was not preserved'] });
    expect(upsertProject).toHaveBeenCalledWith(2, '__unknown__', null, 'Unknown project');
    expect(updateSyncState).toHaveBeenCalledWith(2, 'sessions', 1, 0, 'one record was not preserved');
  });

  it('records a bad rollout without aborting the rest of the run', async () => {
    const base = await mkdtemp(join(tmpdir(), 'codex-sync-'));
    dirs.push(base);
    await mkdir(join(base, 'sessions'), { recursive: true });
    await writeSession(join(base, 'sessions', 'bad.jsonl'), {
      id: 'bad', cwd: '/home/test/project',
    });
    (config.sources.codex as { path: string }).path = base;
    syncSession.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await syncCodex();
    expect(result.errors[0]).toContain('Failed to sync Codex session');
  });
});
