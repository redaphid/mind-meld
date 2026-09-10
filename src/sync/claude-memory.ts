import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { config } from '../config.js';
import { queries } from '../db/postgres.js';
import { decodeProjectPath, extractProjectName } from '../parsers/claude-messages.js';
import {
  isIndexFile,
  memoryTitle,
  parseMemoryFile,
  type ParsedMemory,
} from '../parsers/claude-memory.js';
import { resolveProjectPath, lastPathSegment } from '../utils/project-path.js';

// Sync for Claude Code MEMORIES -- the markdown files under
// `~/.claude/projects/<slug>/memory/`.
//
// Two jobs, and the second is the reason this is not just another parser
// bolted onto transcript sync:
//
//   INDEX   -- memories are the densest text this user owns. Each one is a
//              fact distilled from a whole conversation, already deduplicated
//              and already explained. They belong in search next to the
//              transcripts they came from.
//
//   BACK UP -- a memory file is edited in place and deleted outright when it
//              turns out to be wrong. `~/.claude` is not in git and this box
//              crashes. Nothing anywhere keeps the previous text of a memory,
//              so a correction silently destroys what it corrects and a wrong
//              delete is unrecoverable.
//
// The backup falls out of the storage model rather than being a separate
// mechanism: a memory is a SESSION and every distinct version of its text is a
// MESSAGE appended to that session, keyed by content hash. Re-running sync on
// an unchanged file inserts nothing (ON CONFLICT DO NOTHING); an edit appends;
// a deletion appends nothing and removes nothing, so the last indexed text
// outlives the file. `scripts/restore-memories.ts` writes any of it back.
//
// Reusing sessions/messages instead of dedicated tables is deliberate. It
// means memories get semantic search, FTS, chunking, tags and the embedding
// queue with no changes to any of them -- src/embeddings/pending.ts selects on
// `role != 'tool'`, so these rows enter the queue the moment they are written.
// A `memories` table would have needed every one of those paths taught about
// it, and the ones nobody remembered to teach would have been silently empty.
export interface MemorySyncStats {
  // Project directories that had a memory/ directory at all.
  memoryDirsFound: number;
  filesSeen: number;
  // Memory files that produced or updated a session row.
  memoriesIndexed: number;
  // NEW versions written this run. On a steady-state run this is 0, and that
  // is success rather than idleness -- see `unchanged`.
  versionsInserted: number;
  // Files whose current text was already stored. The normal outcome.
  unchanged: number;
  // Skipped by the incremental mtime fast path, without reading the file.
  skipped: number;
  errors: string[];
}

export const emptyMemoryStats = (): MemorySyncStats => ({
  memoryDirsFound: 0,
  filesSeen: 0,
  memoriesIndexed: 0,
  versionsInserted: 0,
  unchanged: 0,
  skipped: 0,
  errors: [],
});

// The session external_id for a memory file. Namespaced so it can never
// collide with a transcript's session id (a uuid) inside the same project.
export const memoryExternalId = (fileName: string): string => `memory:${fileName}`;

// The message external_id for one version. The hash IS the identity: the same
// text is the same version no matter when it was observed or on which machine,
// so two machines syncing the same memory converge on one row instead of
// racing to append duplicates.
export const versionExternalId = (contentHash: string): string => `version:${contentHash}`;

export interface DiscoveredMemories {
  files: string[];
  errors: string[];
}

// Memory files in one project's memory/ directory. Flat, not recursive: the
// memory system writes one file per fact into one directory, and a
// subdirectory would be something else that has not been designed yet.
export async function discoverMemoryFiles(memoryDir: string): Promise<DiscoveredMemories> {
  const files: string[] = [];
  const errors: string[] = [];

  let entries;
  try {
    entries = await readdir(memoryDir, { withFileTypes: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // No memory/ directory is the normal state for most projects -- it means
    // nothing was ever learned there, not that a read failed.
    if (err?.code !== 'ENOENT') errors.push(`Failed to read memory directory ${memoryDir}: ${e}`);
    return { files, errors };
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(join(memoryDir, entry.name));
    }
  }

  return { files: files.sort(), errors };
}

// Every `<basePath>/projects/*/memory` that exists.
export async function discoverMemoryDirs(
  basePath: string
): Promise<{ dirs: { projectDirName: string; memoryDir: string }[]; errors: string[] }> {
  const projectsDir = join(basePath, 'projects');
  const dirs: { projectDirName: string; memoryDir: string }[] = [];
  const errors: string[] = [];

  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (e) {
    errors.push(`Failed to discover Claude Code projects for memories: ${e}`);
    return { dirs, errors };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const memoryDir = join(projectsDir, entry.name, 'memory');
    try {
      const s = await stat(memoryDir);
      if (s.isDirectory()) dirs.push({ projectDirName: entry.name, memoryDir });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') errors.push(`Failed to check memory directory ${memoryDir}: ${e}`);
    }
  }

  return { dirs, errors };
}

// What a reader needs about a memory that the raw markdown does not say:
// which file it came from, which version this is, and what it links to.
const memoryMetadata = (memory: ParsedMemory, versionNum: number) => ({
  kind: 'claude_memory' as const,
  fileName: memory.fileName,
  filePath: memory.filePath,
  name: memory.name,
  description: memory.description,
  memoryType: memory.type,
  links: memory.links,
  contentHash: memory.contentHash,
  isIndex: isIndexFile(memory.filePath),
  versionNum,
});

// Index one memory file, appending its current text as a version if that text
// is not already stored.
async function syncMemoryFile(params: {
  projectId: number;
  memory: ParsedMemory;
  modifiedAt: Date;
}): Promise<{ versionsInserted: number; unchanged: number; errors: string[] }> {
  const { projectId, memory, modifiedAt } = params;
  const errors: string[] = [];

  const externalId = memoryExternalId(memory.fileName);
  const existing = await queries.getSessionByExternalId(projectId, externalId);

  const sessionId = await queries.upsertSession({
    projectId,
    externalId,
    title: memoryTitle(memory),
    rawFilePath: memory.filePath,
    fileModifiedAt: modifiedAt,
    // The first time we ever saw this memory is the closest thing to its birth
    // that survives; upsertSession COALESCEs, so the earliest run wins and a
    // later edit cannot move it forward.
    startedAt: existing ? undefined : modifiedAt,
    // The latest version's time. Sessions whose ended_at is inside the last 30
    // minutes are held back from aggregate embedding as "still active", which
    // is right here too: a memory being edited right now can wait.
    endedAt: modifiedAt,
  });

  // The version number is positional, not authoritative: it counts versions
  // this index has SEEN, and two edits made between two syncs collapse into
  // one. Stored anyway because "the third text we ever saw for this memory" is
  // exactly what a restore needs to be able to name.
  const versionNum = (existing?.message_count ?? 0) + 1;

  try {
    const messageId = await queries.insertMessage({
      sessionId,
      externalId: versionExternalId(memory.contentHash),
      role: 'memory',
      // The WHOLE file, frontmatter included. A backup that stored only the
      // body could not restore the file, and search wants the description and
      // type as much as it wants the prose.
      contentText: memory.content,
      contentJson: memoryMetadata(memory, versionNum),
      timestamp: modifiedAt,
      sequenceNum: versionNum,
    });

    if (messageId === null) {
      // Conflict on (session_id, external_id): this exact text is already
      // stored. The steady state, and the reason a re-sync is cheap.
      await queries.updateSessionStats(sessionId);
      return { versionsInserted: 0, unchanged: 1, errors };
    }
  } catch (e) {
    errors.push(`Failed to store memory version ${memory.filePath}: ${e}`);
    return { versionsInserted: 0, unchanged: 0, errors };
  }

  await queries.updateSessionStats(sessionId);
  await queries.updateSessionContentChars(sessionId);

  return { versionsInserted: 1, unchanged: 0, errors };
}

export async function syncClaudeMemories(options?: {
  incremental?: boolean;
  projectFilter?: string;
}): Promise<MemorySyncStats> {
  const stats = emptyMemoryStats();
  const basePath = config.sources.claudeCode.path;

  const source = await queries.getSourceByName('claude_code');
  if (!source) {
    stats.errors.push('Claude Code source not found in database');
    return stats;
  }

  const { dirs, errors: discoverErrors } = await discoverMemoryDirs(basePath);
  stats.errors.push(...discoverErrors);
  for (const e of discoverErrors) console.error(e);

  console.log(`Found ${dirs.length} project(s) with memories`);

  for (const { projectDirName, memoryDir } of dirs) {
    const decodedGuess = decodeProjectPath(projectDirName);
    if (
      options?.projectFilter &&
      !decodedGuess.includes(options.projectFilter) &&
      !projectDirName.includes(options.projectFilter)
    ) {
      continue;
    }

    stats.memoryDirsFound++;

    try {
      // Memories hang off the SAME project row as that project's transcripts,
      // so a hit on a memory and a hit on the conversation that produced it
      // agree about where they came from. Passing the raw dir-name fallback is
      // safe: upsertProject keeps an already-verified path when the incoming
      // path is just the external id. Only transcript sync, which has a
      // session cwd, is allowed to verify a path (#22, #33).
      const initial = resolveProjectPath({ dirName: projectDirName });
      const projectId = await queries.upsertProject(
        source.id,
        projectDirName,
        initial.path,
        extractProjectName(decodedGuess)
      );

      const { files, errors: walkErrors } = await discoverMemoryFiles(memoryDir);
      stats.errors.push(...walkErrors);
      for (const e of walkErrors) console.error(e);

      for (const filePath of files) {
        stats.filesSeen++;
        try {
          const fileStat = await stat(filePath);
          const fileName = lastPathSegment(filePath).replace(/\.md$/i, '');

          if (options?.incremental) {
            const existing = await queries.getSessionByExternalId(
              projectId,
              memoryExternalId(fileName)
            );
            if (
              existing?.file_modified_at &&
              fileStat.mtime.getTime() === existing.file_modified_at.getTime()
            ) {
              stats.skipped++;
              continue;
            }
          }

          const memory = await parseMemoryFile(filePath);
          if (!memory) {
            // Empty or unreadable. Not an error -- an empty memory file is a
            // half-written one, and it will still be there next run.
            stats.skipped++;
            continue;
          }

          const result = await syncMemoryFile({
            projectId,
            memory,
            modifiedAt: fileStat.mtime,
          });
          stats.memoriesIndexed++;
          stats.versionsInserted += result.versionsInserted;
          stats.unchanged += result.unchanged;
          stats.errors.push(...result.errors);
        } catch (e) {
          const error = `Failed to sync memory ${filePath}: ${e}`;
          console.error(error);
          stats.errors.push(error);
        }
      }
    } catch (e) {
      const error = `Failed to process memories for project ${projectDirName}: ${e}`;
      console.error(error);
      stats.errors.push(error);
    }
  }

  console.log(
    `Claude memory sync complete: ${stats.memoriesIndexed} memories across ${stats.memoryDirsFound} project(s), ${stats.versionsInserted} new version(s), ${stats.unchanged} unchanged, ${stats.skipped} skipped`
  );

  return stats;
}
