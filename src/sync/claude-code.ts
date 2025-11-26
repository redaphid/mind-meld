import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { config } from '../config.js';
import { queries } from '../db/postgres.js';
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
  errors: string[];
}

// Discover all Claude Code project directories
async function discoverProjects(basePath: string): Promise<string[]> {
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

// Discover session files in a project directory
async function discoverSessionFiles(projectPath: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await readdir(projectPath);
    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) {
        files.push(join(projectPath, entry));
      }
    }
  } catch (e) {
    console.error(`Failed to discover sessions in ${projectPath}:`, e);
  }

  return files;
}

// Sync a single session to the database
async function syncSession(
  sourceId: number,
  projectId: number,
  session: ParsedSession
): Promise<{ messagesInserted: number }> {
  // Upsert session
  const sessionId = await queries.upsertSession({
    projectId,
    externalId: session.sessionId,
    title: session.messages[0]?.contentText?.slice(0, 200),
    isAgent: session.isAgent,
    agentId: session.agentId,
    claudeVersion: session.claudeVersion,
    modelUsed: session.modelUsed,
    gitBranch: session.gitBranch,
    cwd: session.cwd,
    rawFilePath: session.filePath,
    fileModifiedAt: session.fileModifiedAt,
  });

  let messagesInserted = 0;

  // Insert messages
  for (const message of session.messages) {
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
  }

  // Update session stats
  await queries.updateSessionStats(sessionId);

  return { messagesInserted };
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

  // Get last sync state
  const syncState = await queries.getSyncState(source.id, 'sessions');

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
      // Upsert project
      const projectId = await queries.upsertProject(
        source.id,
        projectDirName,
        decodedPath,
        projectName
      );

      stats.projectsProcessed++;

      // Discover and process session files
      const sessionFiles = await discoverSessionFiles(projectPath);

      for (const sessionFile of sessionFiles) {
        try {
          const fileStat = await stat(sessionFile);

          // Skip if incremental and file hasn't changed
          if (
            options?.incremental &&
            syncState?.last_file_modified &&
            fileStat.mtime <= syncState.last_file_modified
          ) {
            stats.skipped++;
            continue;
          }

          // Check if already synced with same modification time
          const fileName = sessionFile.split('/').pop()!.replace('.jsonl', '');
          const isAgent = fileName.startsWith('agent-');
          const sessionExternalId = isAgent ? fileName : fileName;

          const existingSession = await queries.getSessionByExternalId(projectId, sessionExternalId);
          if (
            existingSession?.file_modified_at &&
            fileStat.mtime.getTime() === existingSession.file_modified_at.getTime()
          ) {
            stats.skipped++;
            continue;
          }

          // Parse session
          const session = await parseClaudeSessionFile(sessionFile);
          if (!session || session.messages.length === 0) {
            stats.skipped++;
            continue;
          }

          // Sync to database
          const result = await syncSession(source.id, projectId, session);
          stats.sessionsProcessed++;
          stats.messagesInserted += result.messagesInserted;

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
export async function syncClaudeHistory(): Promise<{ entriesInserted: number }> {
  const basePath = config.sources.claudeCode.path;
  const historyPath = join(basePath, 'history.jsonl');

  const source = await queries.getSourceByName('claude_code');
  if (!source) {
    throw new Error('Claude Code source not found');
  }

  const entries = await parseHistoryFile(historyPath);
  console.log(`Parsed ${entries.length} history entries`);

  // TODO: Insert history entries into database
  // For now, just return count
  return { entriesInserted: entries.length };
}
