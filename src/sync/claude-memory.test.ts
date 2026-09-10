import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const {
  getSourceByName,
  upsertProject,
  getSessionByExternalId,
  upsertSession,
  insertMessage,
  updateSessionStats,
  updateSessionContentChars,
} = vi.hoisted(() => ({
  getSourceByName: vi.fn(),
  upsertProject: vi.fn(),
  getSessionByExternalId: vi.fn(),
  upsertSession: vi.fn(),
  insertMessage: vi.fn(),
  updateSessionStats: vi.fn(),
  updateSessionContentChars: vi.fn(),
}));

vi.mock('../db/postgres.js', () => ({
  queries: {
    getSourceByName,
    upsertProject,
    getSessionByExternalId,
    upsertSession,
    insertMessage,
    updateSessionStats,
    updateSessionContentChars,
  },
}));

const { configMock } = vi.hoisted(() => ({
  configMock: { sources: { claudeCode: { path: '' } }, machine: 'test-machine', os: 'linux' },
}));

vi.mock('../config.js', () => ({ config: configMock }));

const {
  discoverMemoryDirs,
  discoverMemoryFiles,
  memoryExternalId,
  versionExternalId,
  syncClaudeMemories,
} = await import('./claude-memory.js');

const MEMORY = `---
name: sample-memory
description: A fact worth keeping
metadata:
  type: feedback
---

The body of the memory, long enough to clear the noise floor for embedding.
`;

const makeTree = async (files: Record<string, string>): Promise<string> => {
  const base = await mkdtemp(join(tmpdir(), 'mm-memsync-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(base, relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  configMock.sources.claudeCode.path = base;
  return base;
};

beforeEach(() => {
  vi.clearAllMocks();
  getSourceByName.mockResolvedValue({ id: 1, name: 'claude_code' });
  upsertProject.mockResolvedValue(7);
  getSessionByExternalId.mockResolvedValue(null);
  upsertSession.mockResolvedValue(42);
  insertMessage.mockResolvedValue(100);
  updateSessionStats.mockResolvedValue(undefined);
  updateSessionContentChars.mockResolvedValue(undefined);
});

describe('external ids', () => {
  // A memory session shares a project with transcript sessions whose external
  // ids are uuids. The namespace is what keeps them from ever colliding.
  it('namespaces memories away from transcript session ids', () => {
    expect(memoryExternalId('relay-brevity')).toBe('memory:relay-brevity');
    expect(versionExternalId('abc123')).toBe('version:abc123');
  });
});

describe('discoverMemoryFiles', () => {
  it('finds markdown files and ignores everything else', async () => {
    const base = await makeTree({
      'projects/proj-a/memory/one.md': MEMORY,
      'projects/proj-a/memory/MEMORY.md': '# Memory Index\n',
      'projects/proj-a/memory/notes.txt': 'ignored',
    });
    try {
      const { files, errors } = await discoverMemoryFiles(join(base, 'projects/proj-a/memory'));
      expect(errors).toEqual([]);
      expect(files.map((f) => f.split(/[\\/]/).pop())).toEqual(['MEMORY.md', 'one.md']);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // Most projects never learned anything. A missing directory is the normal
  // state and must not be reported as a failure, or every run would show
  // dozens of errors and exit nonzero.
  it('reports no error for a project without a memory directory', async () => {
    const base = await makeTree({ 'projects/proj-a/session.jsonl': '{}\n' });
    try {
      const { files, errors } = await discoverMemoryFiles(join(base, 'projects/proj-a/memory'));
      expect(files).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('discoverMemoryDirs', () => {
  it('returns only the projects that have memories', async () => {
    const base = await makeTree({
      'projects/proj-a/memory/one.md': MEMORY,
      'projects/proj-b/session.jsonl': '{}\n',
      'projects/proj-c/memory/two.md': MEMORY,
    });
    try {
      const { dirs, errors } = await discoverMemoryDirs(base);
      expect(errors).toEqual([]);
      expect(dirs.map((d) => d.projectDirName).sort()).toEqual(['proj-a', 'proj-c']);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('syncClaudeMemories', () => {
  it('stores the whole file, frontmatter included, as one version', async () => {
    const base = await makeTree({ 'projects/proj-a/memory/sample-memory.md': MEMORY });
    try {
      const stats = await syncClaudeMemories();

      expect(stats.errors).toEqual([]);
      expect(stats.memoriesIndexed).toBe(1);
      expect(stats.versionsInserted).toBe(1);

      const message = insertMessage.mock.calls[0][0];
      // Frontmatter must survive: a backup that stored only the body could not
      // rebuild the file, and search wants the description too.
      expect(message.contentText).toBe(MEMORY);
      expect(message.role).toBe('memory');
      expect(message.sequenceNum).toBe(1);
      expect(message.contentJson).toMatchObject({
        kind: 'claude_memory',
        name: 'sample-memory',
        memoryType: 'feedback',
        versionNum: 1,
      });

      const session = upsertSession.mock.calls[0][0];
      expect(session.externalId).toBe('memory:sample-memory');
      expect(session.title).toContain('A fact worth keeping');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // The steady state: nothing new to store is a success, and it must be
  // distinguishable from having done nothing at all.
  it('counts an already-stored text as unchanged, not as an insert', async () => {
    const base = await makeTree({ 'projects/proj-a/memory/sample-memory.md': MEMORY });
    try {
      // ON CONFLICT DO NOTHING returns no row.
      insertMessage.mockResolvedValue(null);
      const stats = await syncClaudeMemories();
      expect(stats.versionsInserted).toBe(0);
      expect(stats.unchanged).toBe(1);
      expect(stats.errors).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // The backup property. An edit appends a new version keyed by the new hash;
  // it does not overwrite the row holding the old text.
  it('appends an edit as the next version instead of replacing the old one', async () => {
    const base = await makeTree({ 'projects/proj-a/memory/sample-memory.md': MEMORY });
    try {
      await syncClaudeMemories();
      const first = insertMessage.mock.calls[0][0];

      // The memory now has one stored version, and the file has been edited.
      getSessionByExternalId.mockResolvedValue({
        id: 42,
        file_modified_at: new Date('2020-01-01T00:00:00Z'),
        content_chars: 100,
        message_count: 1,
      });
      await writeFile(
        join(base, 'projects/proj-a/memory/sample-memory.md'),
        MEMORY.replace('A fact worth keeping', 'A corrected fact'),
        'utf8'
      );

      await syncClaudeMemories();
      const second = insertMessage.mock.calls[1][0];

      expect(second.externalId).not.toBe(first.externalId);
      expect(second.sequenceNum).toBe(2);
      expect(second.contentText).toContain('A corrected fact');
      // Same session: the two versions are a history of one memory.
      expect(second.sessionId).toBe(first.sessionId);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('skips an unchanged file on an incremental run without reading it', async () => {
    const base = await makeTree({ 'projects/proj-a/memory/sample-memory.md': MEMORY });
    try {
      const when = new Date('2026-01-01T00:00:00Z');
      await utimes(join(base, 'projects/proj-a/memory/sample-memory.md'), when, when);
      getSessionByExternalId.mockResolvedValue({
        id: 42,
        file_modified_at: when,
        content_chars: 100,
        message_count: 1,
      });

      const stats = await syncClaudeMemories({ incremental: true });
      expect(stats.skipped).toBe(1);
      expect(insertMessage).not.toHaveBeenCalled();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // One bad memory costs exactly itself. The corpus exists nowhere else, so a
  // single failure must never end the run that is backing up the rest.
  it('keeps indexing the other memories when one fails to store', async () => {
    const base = await makeTree({
      'projects/proj-a/memory/first.md': MEMORY,
      'projects/proj-a/memory/second.md': MEMORY.replace('sample-memory', 'second-memory'),
    });
    try {
      insertMessage.mockRejectedValueOnce(new Error('NUL byte'));
      const stats = await syncClaudeMemories();

      expect(stats.memoriesIndexed).toBe(2);
      expect(stats.versionsInserted).toBe(1);
      expect(stats.errors).toHaveLength(1);
      expect(stats.errors[0]).toContain('Failed to store memory version');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('honours a project filter instead of indexing every project', async () => {
    const base = await makeTree({
      'projects/proj-a/memory/sample-memory.md': MEMORY,
      'projects/proj-b/memory/other.md': MEMORY,
    });
    try {
      const stats = await syncClaudeMemories({ projectFilter: 'proj-b' });
      expect(stats.memoryDirsFound).toBe(1);
      expect(upsertProject.mock.calls[0][1]).toBe('proj-b');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // An empty file is a half-written memory, not a version. Storing it would
  // append a blank "version" and push the real text to v2.
  it('skips an empty memory file without storing a version', async () => {
    const base = await makeTree({ 'projects/proj-a/memory/half-written.md': '   \n' });
    try {
      const stats = await syncClaudeMemories();
      expect(stats.skipped).toBe(1);
      expect(stats.versionsInserted).toBe(0);
      expect(insertMessage).not.toHaveBeenCalled();
      expect(stats.errors).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('reports a missing claude_code source as an error rather than syncing nothing quietly', async () => {
    const base = await makeTree({ 'projects/proj-a/memory/sample-memory.md': MEMORY });
    try {
      getSourceByName.mockResolvedValue(null);
      const stats = await syncClaudeMemories();
      expect(stats.errors).toHaveLength(1);
      expect(stats.memoriesIndexed).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  // Memories attach to the project row transcripts already use, and must never
  // overwrite a path that transcript sync verified from a session cwd.
  it('passes the raw directory-name fallback as the project path', async () => {
    const base = await makeTree({ 'projects/proj-a/memory/sample-memory.md': MEMORY });
    try {
      await syncClaudeMemories();
      const [, externalId, path] = upsertProject.mock.calls[0];
      expect(externalId).toBe('proj-a');
      expect(path).toBe('proj-a');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
