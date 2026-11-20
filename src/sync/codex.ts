import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { queries } from '../db/postgres.js';
import { parseCodexSessionFile } from '../parsers/codex-messages.js';
import { lastPathSegment } from '../utils/project-path.js';
import { syncSession, type DiscoveredSessions, type SyncStats } from './claude-code.js';

export async function discoverCodexSessions(basePath: string): Promise<DiscoveredSessions> {
  const files: string[] = [];
  const errors: string[] = [];

  const walk = async (dir: string, optional = false): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      errors.push(`Failed to read directory ${dir}: ${error}`);
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  };

  await walk(join(basePath, 'sessions'), true);
  await walk(join(basePath, 'archived_sessions'), true);
  return { files, errors };
}

export async function syncCodex(options?: { incremental?: boolean }): Promise<SyncStats> {
  const stats: SyncStats = {
    projectsProcessed: 0,
    sessionsProcessed: 0,
    messagesInserted: 0,
    skipped: 0,
    quarantined: 0,
    errors: [],
  };
  const source = await queries.getSourceByName('codex');
  if (!source) {
    stats.errors.push('Codex source not found in database');
    return stats;
  }

  const discovered = await discoverCodexSessions(config.sources.codex.path);
  stats.errors.push(...discovered.errors);
  const projects = new Set<number>();

  // Rollout names begin with their creation timestamp. Explicit sorting keeps
  // parent tasks ahead of the subagents they spawned, independent of readdir's
  // filesystem-specific order, so parent_session_id resolves on a fresh index.
  for (const filePath of discovered.files.sort()) {
    try {
      const fileStats = await stat(filePath);
      const session = await parseCodexSessionFile(filePath);
      if (!session) {
        stats.skipped++;
        continue;
      }

      const existing = await queries.getSessionByExternalIdGlobal(source.id, session.sessionId);
      if (
        options?.incremental &&
        existing?.file_modified_at &&
        existing.file_modified_at.getTime() === fileStats.mtime.getTime()
      ) {
        stats.skipped++;
        continue;
      }

      // A spawned task may run in an isolated worktree. It still belongs to
      // the parent conversation's project; keeping it there also lets the
      // shared session writer resolve the parent link within that project.
      const parent = session.parentSessionId
        ? await queries.getSessionByExternalIdGlobal(source.id, session.parentSessionId)
        : null;
      const projectPath = session.cwd ?? '__unknown__';
      const projectId = parent?.project_id ?? await queries.upsertProject(
        source.id,
        projectPath,
        session.cwd ?? null,
        session.cwd ? lastPathSegment(session.cwd) : 'Unknown project'
      );
      projects.add(projectId);

      const result = await syncSession(source.id, projectId, session, 'codex');
      stats.sessionsProcessed++;
      stats.messagesInserted += result.messagesInserted;
      stats.quarantined += result.quarantined;
      stats.errors.push(...result.errors);
    } catch (error) {
      const message = `Failed to sync Codex session ${filePath}: ${error}`;
      console.error(message);
      stats.errors.push(message);
    }
  }

  stats.projectsProcessed = projects.size;
  await queries.updateSyncState(
    source.id,
    'sessions',
    stats.projectsProcessed,
    stats.messagesInserted,
    stats.errors.length ? stats.errors.join('; ') : undefined
  );
  console.log(
    `Codex sync complete: ${stats.projectsProcessed} projects, ${stats.sessionsProcessed} sessions, ${stats.messagesInserted} messages`
  );
  return stats;
}
