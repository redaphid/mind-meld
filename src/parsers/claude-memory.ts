import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { normalizeDeep } from '../utils/text-encoding.js';

// A single Claude Code memory file: `~/.claude/projects/<slug>/memory/<name>.md`.
//
// Memories are hand-sized markdown documents with YAML-ish frontmatter, written
// by agents as they learn how this user works. They are NOT transcripts: there
// is one per fact, they are edited in place, and the only history that exists
// is whatever a reader kept. That last part is why sync stores every distinct
// version rather than the current text (see src/sync/claude-memory.ts).
export interface ParsedMemory {
  // The file's own name without extension — `relay-brevity`. Used as the
  // identity on disk, and the fallback when frontmatter carries no `name`.
  fileName: string;
  filePath: string;
  // Frontmatter `name:`. The slug other memories link to with [[name]].
  name: string | null;
  description: string | null;
  // `metadata.type` — user | feedback | project | reference. Free text here on
  // purpose: an unrecognised type is recorded as written, never dropped. The
  // vocabulary is a convention of the memory system, not of this parser, and a
  // parser that rejected a new word would lose the memory that introduced it.
  type: string | null;
  // Everything after the frontmatter, verbatim.
  body: string;
  // The whole file, verbatim. This is what gets stored and hashed — a backup
  // that dropped the frontmatter could not restore the file.
  content: string;
  // [[wikilinks]] found in the body, in order, deduped.
  links: string[];
  // sha256 of `content`. The version identity: same hash, same file, nothing
  // to store. Content-addressed rather than mtime-based because a touched file
  // is not a new version, and an edit that restores an earlier text is not one
  // either.
  contentHash: string;
}

// The MEMORY.md index is a memory file by location but not by shape: it has no
// frontmatter and is a list of pointers to the others. It is still indexed —
// it is the only place the *shape* of the memory set is written down — but it
// is marked so a reader can tell an index from a fact.
const INDEX_FILE_NAME = 'MEMORY.md';

export const isIndexFile = (filePath: string): boolean =>
  basename(filePath).toLowerCase() === INDEX_FILE_NAME.toLowerCase();

// Frontmatter is parsed with a small hand-written reader rather than a YAML
// dependency. The shape is fixed and tiny (three scalars, one of them nested
// one level under `metadata:`), and every file in the corpus is written by the
// same instructions. A real YAML parser would buy correctness for documents
// this format never contains, at the cost of a dependency in the sync path.
//
// Anything it cannot read is not an error: the body still indexes, and a
// memory with unreadable frontmatter is worth more indexed than skipped.
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const unquote = (value: string): string =>
  value.replace(/^['"]/, '').replace(/['"]$/, '').trim();

export const parseFrontmatter = (
  content: string
): { fields: { name: string | null; description: string | null; type: string | null }; body: string } => {
  const match = FRONTMATTER.exec(content);
  if (!match) {
    return { fields: { name: null, description: null, type: null }, body: content };
  }

  const [, block] = match;
  const body = content.slice(match[0].length);

  let name: string | null = null;
  let description: string | null = null;
  let type: string | null = null;
  // Tracks whether we are inside the `metadata:` block, so a top-level `type:`
  // and `metadata.type` are not confused for one another.
  let inMetadata = false;

  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const indented = /^\s/.test(rawLine);
    const line = rawLine.trim();

    if (!indented) inMetadata = line === 'metadata:' || line.startsWith('metadata:');

    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = unquote(line.slice(sep + 1));

    if (!value) continue;
    if (key === 'name' && !indented) name = value;
    else if (key === 'description' && !indented) description = value;
    else if (key === 'type') type = value.toLowerCase();
  }

  return { fields: { name, description, type }, body };
};

// [[wikilinks]]. Deduped, order preserved: the link graph is a set of
// relationships, and a memory that mentions another twice is not twice related.
export const extractLinks = (body: string): string[] => {
  const seen = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const link = m[1].trim();
    if (link) seen.add(link);
  }
  return [...seen];
};

export const hashContent = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

export const parseMemoryContent = (filePath: string, raw: string): ParsedMemory => {
  // Normalized on the way in for the same reason transcripts are: mismatched
  // encodings are what make the same text look like two versions.
  const content = normalizeDeep(raw) as string;
  const { fields, body } = parseFrontmatter(content);
  const fileName = basename(filePath).replace(/\.md$/i, '');

  return {
    fileName,
    filePath,
    name: fields.name,
    description: fields.description,
    type: fields.type,
    body,
    content,
    links: extractLinks(body),
    contentHash: hashContent(content),
  };
};

export const parseMemoryFile = async (filePath: string): Promise<ParsedMemory | null> => {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    // Unreadable is not fatal to a sync run. The caller counts it; the rest of
    // the memory directory still indexes.
    return null;
  }
  if (!raw.trim()) return null;
  return parseMemoryContent(filePath, raw);
};

// The human-facing title for a memory's session row. Description first — it is
// written to be read in a list, which is exactly what a title is for.
export const memoryTitle = (memory: ParsedMemory): string => {
  const slug = memory.name ?? memory.fileName;
  if (isIndexFile(memory.filePath)) return `Memory index: ${slug}`;
  return memory.description ? `Memory: ${slug} — ${memory.description}` : `Memory: ${slug}`;
};
