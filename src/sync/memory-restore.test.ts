import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../db/postgres.js', () => ({ query: queryMock }));

const { listMemories, restoreMemory, restoreTarget } = await import('./memory-restore.js');
const { hashContent } = await import('../parsers/claude-memory.js');

const CONTENT = `---
name: sample-memory
description: A fact worth keeping
---

The body.
`;

const row = (over: Record<string, unknown> = {}) => ({
  sessionId: 42,
  projectExternalId: 'proj-a',
  projectPath: '/work/proj-a',
  fileName: 'sample-memory',
  versionNum: 2,
  contentHash: hashContent(CONTENT),
  content: CONTENT,
  timestamp: new Date('2026-01-01T00:00:00Z'),
  rawFilePath: null as string | null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('listMemories', () => {
  it('returns the latest stored version of each memory', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          session_id: 42,
          project_external_id: 'proj-a',
          project_path: '/work/proj-a',
          external_id: 'memory:sample-memory',
          version_num: 3,
          content_text: CONTENT,
          timestamp: new Date('2026-01-01T00:00:00Z'),
          raw_file_path: '/home/user/.claude/projects/proj-a/memory/sample-memory.md',
        },
      ],
    });

    const memories = await listMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0].fileName).toBe('sample-memory');
    expect(memories[0].versionNum).toBe(3);
    expect(memories[0].contentHash).toBe(hashContent(CONTENT));
  });

  it('scopes the query when a project filter is given', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await listMemories({ projectFilter: 'proj-a' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('ILIKE');
    expect(params).toEqual(['%proj-a%']);
  });
});

describe('restoreTarget', () => {
  it('restores to the path sync last read the file from', () => {
    const target = restoreTarget(row({ rawFilePath: '/m/proj-a/memory/sample-memory.md' }));
    expect(target).toBe('/m/proj-a/memory/sample-memory.md');
  });

  it('groups by project slug under an explicit output directory', () => {
    expect(restoreTarget(row(), '/out')).toBe(join('/out', 'proj-a', 'sample-memory.md'));
  });

  // Better to refuse than to invent a destination: a restore that silently
  // wrote somewhere unexpected is a backup nobody finds.
  it('refuses to guess when there is no recorded path and no output directory', () => {
    expect(() => restoreTarget(row())).toThrow(/No recorded path/);
  });
});

describe('restoreMemory', () => {
  it('writes a memory whose file no longer exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-restore-'));
    try {
      const outcome = await restoreMemory(row(), { outDir: dir });
      expect(outcome.status).toBe('written');
      expect(await readFile(outcome.targetPath, 'utf8')).toBe(CONTENT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports an unchanged file as identical without rewriting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-restore-'));
    try {
      const first = await restoreMemory(row(), { outDir: dir });
      const second = await restoreMemory(row(), { outDir: dir });
      expect(first.status).toBe('written');
      expect(second.status).toBe('identical');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The dangerous direction. The file on disk may be NEWER than anything
  // indexed, and clobbering it would destroy exactly the unbacked-up text this
  // feature exists to protect.
  it('refuses by default to overwrite a file whose text differs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-restore-'));
    try {
      const target = join(dir, 'proj-a', 'sample-memory.md');
      await restoreMemory(row(), { outDir: dir });
      await writeFile(target, CONTENT + 'edited since the last sync\n', 'utf8');

      const outcome = await restoreMemory(row(), { outDir: dir });
      expect(outcome.status).toBe('skipped');
      expect(await readFile(target, 'utf8')).toContain('edited since the last sync');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('overwrites a differing file only when forced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-restore-'));
    try {
      const target = join(dir, 'proj-a', 'sample-memory.md');
      await restoreMemory(row(), { outDir: dir });
      await writeFile(target, 'something else\n', 'utf8');

      const outcome = await restoreMemory(row(), { outDir: dir, force: true });
      expect(outcome.status).toBe('written');
      expect(await readFile(target, 'utf8')).toBe(CONTENT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
