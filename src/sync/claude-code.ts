import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { config } from '../config.js';
import { queries } from '../db/postgres.js';
import { quarantine } from './quarantine.js';
import {
  parseClaudeSessionFile,
  decodeProjectPath,
  extractProjectName,
  parseHistoryFile,
  type ParsedSession,
} from '../parsers/claude-messages.js';

export interface SyncStats {
  projectsProcessed: number;
  sessionsProcessed: number;
  messagesInserted: number;
  skipped: number;
  // Records kept for replay instead of being dropped. Non-zero means data is
  // waiting in sync_quarantine, not that data was lost.
  quarantined: number;
  errors: string[];
}

// Discover all Claude Code project directories
export async function discoverProjects(basePath: string): Promise<string[]> {
  const projectsDir = join(basePath, 'projects');
  const projects: string[] = [];

  try {
    const entries = await readdir(projectsDir);
    for (const entry of entries) {
      const fullPath = join(projectsDir, entry);
      const entryStat = await stat(fullPath);
      if (entryStat.isDirectory()) {
        projects.push(fullPath);
      }
    }
  } catch (e) {
    console.error('Failed to discover Claude Code projects:', e);
  }

  return projects;
}

// Discover session files in a project directory. Recursive, because newer
// Claude Code versions store subagent transcripts under
// `<project>/<sessionId>/subagents/agent-*.jsonl` (nested further when agents
// spawn agents) — a top-level-only walk silently missed every one of them.
// On one machine that was 161 of 193 session files invisible to sync (#29).
//
// Failures are returned, not just logged: a directory that cannot be read
// must cost exactly that directory, be visible in stats.errors (and therefore
// the exit code), and never silently shrink the walk.
export interface DiscoveredSessions {
  files: string[];
  errors: string[];
}

export async function discoverSessionFiles(projectPath: string): Promise<DiscoveredSessions> {
  const files: string[] = [];
  const errors: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      // The projects tree is live while sync runs — subagent and workflow
      // directories come and go. One unreadable directory loses only itself.
      errors.push(`Failed to read directory ${dir}: ${e}`);
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
      // Symlinks are deliberately not followed (Dirent.isDirectory/isFile are
      // lstat-based, so a link fails both checks). Claude Code DOES create
      // intra-tree symlinks between subagent transcripts; those targets are
      // discovered once via their real path, and following the link would
      // risk cycles and double-ingest. Known trade-off: a symlink whose
      // target lives outside the walked tree is skipped, and that transcript
      // stays invisible until discovery learns to follow file links with a
      // resolved-path dedup.
    }
  };

  await walk(projectPath);

  return { files, errors };
}

export type SessionSyncResult = {
  messagesInserted: number;
  // Records preserved in sync_quarantine — confirmed written, not just attempted.
  quarantined: number;
  // Records that could NOT be preserved: the original insert failed AND the
  // quarantine write failed. These are reported up into sync errors so
  // /status never claims "data is waiting" for data that was actually lost.
  errors: string[];
};

// Sync a single session to the database. Exported for tests.
export async function syncSession(
  sourceId: number,
  projectId: number,
  session: ParsedSession
): Promise<SessionSyncResult> {
  let quarantined = 0;
  const errors: string[] = [];

  // quarantine() never throws; it returns null when even the preserving write
  // failed. A null must never be counted as saved — it becomes a visible sync
  // error instead.
  const keep = async (input: {
    recordKey: string;
    lineNumber?: number;
    sessionId?: number;
    stage: 'parse' | 'insert';
    payload: string;
    error: unknown;
  }) => {
    const id = await quarantine({
      source: 'claude_code',
      filePath: session.filePath,
      sessionExternalId: session.sessionId,
      projectId,
      ...input,
    });
    if (id === null)
      errors.push(
        `Quarantine write failed for ${session.filePath}#${input.recordKey} — record NOT preserved`
      );
    else quarantined++;
  };

  // Upsert session. This is the one insert the per-message quarantine below
  // cannot protect: if the session row itself fails, there is nothing to
  // attach messages to, and before this guard the whole file just errored on
  // every cycle with nothing preserved (issue #20). Now every record is
  // quarantined against the session's external id and replays once the
  // session row exists — file_modified_at is never advanced on this path, so
  // the next sync retries the file.
  let sessionId: number;
  try {
    sessionId = await queries.upsertSession({
      projectId,
      externalId: session.sessionId,
      // No title. Claude Code transcripts carry no title field, and the old
      // fallback — the first 200 characters of message one — titled every
      // brief-opening conversation with its own brief, permanently, because
      // this is the only write to sessions.title (issue #95). The read path
      // derives a title from the summary instead, and shows none until then.
      title: undefined,
      isAgent: session.isAgent,
      agentId: session.agentId,
      claudeVersion: session.claudeVersion,
      modelUsed: session.modelUsed,
      gitBranch: session.gitBranch,
      cwd: session.cwd,
      rawFilePath: session.filePath,
      fileModifiedAt: session.fileModifiedAt,
      startedAt: session.firstTimestamp,
      endedAt: session.lastTimestamp,
    });
  } catch (e) {
    for (const bad of session.badLines) {
      await keep({
        recordKey: `line:${bad.lineNumber}`,
        lineNumber: bad.lineNumber,
        stage: 'parse',
        payload: bad.raw,
        error: bad.error,
      });
    }
    for (const message of session.messages) {
      await keep({
        recordKey: `uuid:${message.uuid}`,
        lineNumber: session.lineNumbers.get(message.uuid),
        stage: 'insert',
        payload: JSON.stringify(message),
        error: e,
      });
    }
    console.error(
      `Session upsert failed for ${session.filePath} — quarantined ${quarantined} record(s) for replay${errors.length > 0 ? `, ${errors.length} NOT preserved` : ''}: ${e instanceof Error ? e.message : e}`
    );
    return { messagesInserted: 0, quarantined, errors };
  }

  let messagesInserted = 0;

  // Lines the parser could not read at all. Kept before anything else touches
  // them, so a file that is partly unreadable still yields everything else.
  for (const bad of session.badLines) {
    await keep({
      recordKey: `line:${bad.lineNumber}`,
      lineNumber: bad.lineNumber,
      sessionId,
      stage: 'parse',
      payload: bad.raw,
      error: bad.error,
    });
  }

  // Insert messages. One record that Postgres rejects — a NUL byte, a column
  // that does not exist — must not cost the rest of the conversation, so each
  // failure is quarantined and the loop continues.
  for (const message of session.messages) {
    try {
      const msgId = await queries.insertMessage({
        sessionId,
        externalId: message.uuid,
        role: message.role,
        contentText: message.contentText,
        contentJson: message.contentJson,
        toolName: message.toolName,
        toolInput: message.toolInput,
        thinkingText: message.thinkingText,
        model: message.model,
        inputTokens: message.inputTokens,
        outputTokens: message.outputTokens,
        cacheCreationTokens: message.cacheCreationTokens,
        cacheReadTokens: message.cacheReadTokens,
        timestamp: message.timestamp,
        sequenceNum: message.sequenceNum,
        isSidechain: message.isSidechain,
      });

      if (msgId) messagesInserted++;
    } catch (e) {
      await keep({
        recordKey: `uuid:${message.uuid}`,
        lineNumber: session.lineNumbers.get(message.uuid),
        sessionId,
        stage: 'insert',
        payload: JSON.stringify(message),
        error: e,
      });
    }
  }

  if (quarantined > 0)
    console.warn(
      `Quarantined ${quarantined} record(s) from ${session.filePath} — the rest of the session was indexed`
    );

  // Update session stats and content_chars
  await queries.updateSessionStats(sessionId);
  await queries.updateSessionContentChars(sessionId);

  return { messagesInserted, quarantined, errors };
}

// Main sync function for Claude Code
export async function syncClaudeCode(options?: {
  incremental?: boolean;
  projectFilter?: string;
}): Promise<SyncStats> {
  const stats: SyncStats = {
    projectsProcessed: 0,
    sessionsProcessed: 0,
    messagesInserted: 0,
    skipped: 0,
    quarantined: 0,
    errors: [],
  };

  const basePath = config.sources.claudeCode.path;
  console.log(`Syncing Claude Code from ${basePath}...`);

  // Get source ID
  const source = await queries.getSourceByName('claude_code');
  if (!source) {
    stats.errors.push('Claude Code source not found in database');
    return stats;
  }

  // Incremental sync checks each file individually against Postgres
  // No global time cutoff - we check file_modified_at per session
  if (options?.incremental) {
    console.log('Incremental sync: will skip files already synced with same modification time');
  }

  // Discover projects
  const projectPaths = await discoverProjects(basePath);
  console.log(`Found ${projectPaths.length} projects`);

  for (const projectPath of projectPaths) {
    const projectDirName = projectPath.split('/').pop()!;
    const decodedPath = decodeProjectPath(projectDirName);
    const projectName = extractProjectName(decodedPath);

    // Filter if specified
    if (options?.projectFilter && !decodedPath.includes(options.projectFilter)) {
      continue;
    }

    try {
      // Upsert project with decoded path as initial guess
      let projectId = await queries.upsertProject(
        source.id,
        projectDirName,
        decodedPath,
        projectName
      );

      stats.projectsProcessed++;
      let correctedFromCwd = false;

      // Discover and process session files. Walk failures count as sync
      // errors: an unreadable directory means files this run never saw, and
      // that must reach the exit code, not just the console (#29).
      const discovered = await discoverSessionFiles(projectPath);
      for (const walkError of discovered.errors) {
        console.error(walkError);
        stats.errors.push(walkError);
      }

      for (const sessionFile of discovered.files) {
        try {
          const fileStat = await stat(sessionFile);

          // Check if already synced with same modification time (per-file check)
          const fileName = sessionFile.split('/').pop()!.replace('.jsonl', '');
          const isAgent = fileName.startsWith('agent-');
          const sessionExternalId = isAgent ? fileName : fileName;

          const existingSession = await queries.getSessionByExternalId(projectId, sessionExternalId);
          if (
            options?.incremental &&
            existingSession?.file_modified_at &&
            fileStat.mtime.getTime() === existingSession.file_modified_at.getTime()
          ) {
            stats.skipped++;
            continue;
          }

          // Parse session
          const session = await parseClaudeSessionFile(sessionFile);
          if (!session) {
            stats.skipped++;
            continue;
          }

          // A file with nothing readable still has its unreadable lines
          // quarantined — skipping here is what used to lose them. There is no
          // session row to attach them to, so they carry the project and the
          // session's external id and resolve it on replay.
          if (session.messages.length === 0) {
            for (const bad of session.badLines) {
              const quarantineId = await quarantine({
                source: 'claude_code',
                filePath: session.filePath,
                recordKey: `line:${bad.lineNumber}`,
                lineNumber: bad.lineNumber,
                sessionExternalId: session.sessionId,
                projectId,
                stage: 'parse',
                payload: bad.raw,
                error: bad.error,
              });
              // null means even the preserving write failed — that is a loss,
              // and it must surface as an error, never count as saved.
              if (quarantineId === null)
                stats.errors.push(
                  `Quarantine write failed for ${session.filePath}#line:${bad.lineNumber} — record NOT preserved`
                );
              else stats.quarantined++;
            }
            stats.skipped++;
            continue;
          }

          // Correct project path from session cwd (decodeProjectPath is lossy
          // with hyphens). Agent sessions are never allowed to drive this:
          // subagent transcripts carry their isolated worktree as cwd
          // (.claude/worktrees/agent-*), and on incremental runs the freshest
          // file — usually a subagent transcript — is often the only candidate,
          // so one of them would rename the whole project row to agent-xxx.
          if (!correctedFromCwd && session.cwd && !session.isAgent) {
            const cwdName = extractProjectName(session.cwd);
            if (session.cwd !== decodedPath) {
              projectId = await queries.upsertProject(
                source.id,
                projectDirName,
                session.cwd,
                cwdName
              );
            }
            correctedFromCwd = true;
          }

          // Sync to database
          const result = await syncSession(source.id, projectId, session);
          stats.sessionsProcessed++;
          stats.messagesInserted += result.messagesInserted;
          stats.quarantined += result.quarantined;
          stats.errors.push(...result.errors);

          if (stats.sessionsProcessed % 50 === 0) {
            console.log(`Processed ${stats.sessionsProcessed} sessions...`);
          }
        } catch (e) {
          const error = `Failed to sync session ${sessionFile}: ${e}`;
          console.error(error);
          stats.errors.push(error);
        }
      }
    } catch (e) {
      const error = `Failed to process project ${projectPath}: ${e}`;
      console.error(error);
      stats.errors.push(error);
    }
  }

  // Update sync state
  await queries.updateSyncState(
    source.id,
    'sessions',
    stats.projectsProcessed,
    stats.messagesInserted,
    stats.errors.length > 0 ? stats.errors.join('; ') : undefined
  );

  console.log(
    `Claude Code sync complete: ${stats.projectsProcessed} projects, ${stats.sessionsProcessed} sessions, ${stats.messagesInserted} messages`
  );

  return stats;
}

// Sync history.jsonl
export async function syncClaudeHistory(): Promise<{
  entriesInserted: number;
  malformedLines: number;
  invalidTimestamps: number;
}> {
  const basePath = config.sources.claudeCode.path;
  const historyPath = join(basePath, 'history.jsonl');

  const source = await queries.getSourceByName('claude_code');
  if (!source) {
    throw new Error('Claude Code source not found');
  }

  const { entries, malformedLines, invalidTimestamps } = await parseHistoryFile(historyPath);
  console.log(`Parsed ${entries.length} history entries`);
  if (malformedLines > 0 || invalidTimestamps > 0) {
    console.warn(
      `History file ${historyPath}: skipped ${malformedLines} malformed line(s) and ${invalidTimestamps} entr(ies) with unusable timestamps`
    );
  }

  // TODO: Insert history entries into database
  // For now, just return count
  return { entriesInserted: entries.length, malformedLines, invalidTimestamps };
}
