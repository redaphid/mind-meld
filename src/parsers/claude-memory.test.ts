import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractLinks,
  hashContent,
  isIndexFile,
  memoryTitle,
  parseFrontmatter,
  parseMemoryContent,
  parseMemoryFile,
} from './claude-memory.js';

const FIXTURE = `---
name: relay-brevity
description: Keep every relay message short and bulleted
metadata:
  type: feedback
---

Relay messages must be short.

**Why:** long messages do not get read.
**How to apply:** bullets, bold the verdict. See [[relay-queue]] and [[relay-queue]].
`;

describe('parseFrontmatter', () => {
  it('reads name, description and the nested metadata.type', () => {
    const { fields, body } = parseFrontmatter(FIXTURE);
    expect(fields).toEqual({
      name: 'relay-brevity',
      description: 'Keep every relay message short and bulleted',
      type: 'feedback',
    });
    expect(body.startsWith('\nRelay messages must be short.')).toBe(true);
  });

  // A memory whose frontmatter cannot be read is still a memory. Indexing the
  // prose without a description beats skipping the file.
  it('returns the whole document as body when there is no frontmatter', () => {
    const { fields, body } = parseFrontmatter('# MEMORY.md\n\n- [a](a.md)\n');
    expect(fields).toEqual({ name: null, description: null, type: null });
    expect(body).toBe('# MEMORY.md\n\n- [a](a.md)\n');
  });

  // `description:` values routinely contain a colon (they are sentences), and
  // splitting on the last one would have silently amputated them.
  it('keeps everything after the FIRST colon in a value', () => {
    const { fields } = parseFrontmatter(
      '---\ndescription: Standing order: never do the thing\n---\nbody\n'
    );
    expect(fields.description).toBe('Standing order: never do the thing');
  });

  // The type lives one level under `metadata:`. A top-level key of the same
  // name must not be mistaken for it, and vice versa.
  it('does not read a body line as frontmatter', () => {
    const { fields } = parseFrontmatter(`---\nname: a\n---\ntype: not-frontmatter\n`);
    expect(fields.type).toBeNull();
  });

  it('tolerates CRLF line endings', () => {
    const { fields } = parseFrontmatter(
      '---\r\nname: crlf-memory\r\nmetadata:\r\n  type: project\r\n---\r\nbody\r\n'
    );
    expect(fields.name).toBe('crlf-memory');
    expect(fields.type).toBe('project');
  });

  // An unrecognised type is recorded as written. The memory system's
  // vocabulary is a convention, and a parser that dropped a new word would
  // lose exactly the memory that introduced it.
  it('keeps a type outside the documented vocabulary', () => {
    const { fields } = parseFrontmatter('---\nmetadata:\n  type: Postmortem\n---\nbody\n');
    expect(fields.type).toBe('postmortem');
  });
});

describe('extractLinks', () => {
  it('collects wikilinks once each, in order', () => {
    expect(extractLinks('see [[b]] then [[a]] then [[b]] again')).toEqual(['b', 'a']);
  });

  it('finds nothing in prose without links', () => {
    expect(extractLinks('no links here [not a link]')).toEqual([]);
  });
});

describe('parseMemoryContent', () => {
  it('captures the whole file as content, frontmatter included', () => {
    const memory = parseMemoryContent('/tmp/memory/relay-brevity.md', FIXTURE);
    expect(memory.content).toContain('name: relay-brevity');
    expect(memory.fileName).toBe('relay-brevity');
    expect(memory.links).toEqual(['relay-queue']);
    expect(memory.type).toBe('feedback');
  });

  // The version identity. Two files with the same text are one version, and a
  // one-character edit is a different one.
  it('hashes identical text identically and changed text differently', () => {
    const a = parseMemoryContent('/tmp/a.md', FIXTURE);
    const b = parseMemoryContent('/tmp/elsewhere/a.md', FIXTURE);
    const c = parseMemoryContent('/tmp/a.md', FIXTURE + 'one more line\n');
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
    expect(a.contentHash).toBe(hashContent(FIXTURE));
  });
});

describe('memoryTitle', () => {
  it('leads with the description, which is what a list is read for', () => {
    const memory = parseMemoryContent('/tmp/memory/relay-brevity.md', FIXTURE);
    expect(memoryTitle(memory)).toBe(
      'Memory: relay-brevity — Keep every relay message short and bulleted'
    );
  });

  it('falls back to the file name when frontmatter carries none', () => {
    const memory = parseMemoryContent('/tmp/memory/loose-note.md', 'just prose\n');
    expect(memoryTitle(memory)).toBe('Memory: loose-note');
  });

  it('marks the index so a reader can tell it from a fact', () => {
    const memory = parseMemoryContent('/tmp/memory/MEMORY.md', '# Memory Index\n');
    expect(isIndexFile(memory.filePath)).toBe(true);
    expect(memoryTitle(memory)).toBe('Memory index: MEMORY');
  });

  // Titles feed isAutomated() and the Warmup exclusion, either of which would
  // quietly remove a memory from the embedding queue.
  it('never produces a title that reads as automated or as a warmup', () => {
    const memory = parseMemoryContent('/tmp/memory/x.md', 'You are a Slack monitoring assistant\n');
    expect(memoryTitle(memory)).toBe('Memory: x');
  });
});

describe('parseMemoryFile', () => {
  it('reads a file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-memory-'));
    try {
      const path = join(dir, 'relay-brevity.md');
      await writeFile(path, FIXTURE, 'utf8');
      const memory = await parseMemoryFile(path);
      expect(memory?.name).toBe('relay-brevity');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing file rather than throwing', async () => {
    expect(await parseMemoryFile(join(tmpdir(), 'mm-does-not-exist-0000.md'))).toBeNull();
  });

  // A half-written file is not a version. Storing it would append an empty
  // "version" and push the real text to v2.
  it('returns null for an empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-memory-'));
    try {
      const path = join(dir, 'empty.md');
      await writeFile(path, '   \n', 'utf8');
      expect(await parseMemoryFile(path)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
