import { copyFile, mkdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname, basename } from 'path';
import { existsSync } from 'fs';
import { config } from '../config.js';
import { queries } from '../db/postgres.js';
import {
  setDatabasePath,
  listConversations,
  getConversation,
  listMessages,
  queryAll,
} from '@redaphid/cursor-conversations';

export interface CursorSyncStats {
  conversationsProcessed: number;
  messagesInserted: number;
  skipped: number;
  errors: string[];
}

// Get path to Cursor's main state database
function getCursorDbPath(): string {
  if (process.env.CURSOR_DB_PATH) return process.env.CURSOR_DB_PATH;
  if (process.platform === 'darwin') {
    return `${homedir()}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
  }
  if (process.platform === 'win32') {
    return `${homedir()}\\AppData\\Roaming\\Cursor\\User\\globalStorage\\state.vscdb`;
  }
  return `${homedir()}/.config/Cursor/User/globalStorage/state.vscdb`;
}

// Copy Cursor DB to tmp to avoid lock conflicts
async function copyCursorDb(): Promise<string> {
  const srcPath = getCursorDbPath();
  const tmpDir = join(dirname(new URL(import.meta.url).pathname), '../../tmp');
  const destPath = join(tmpDir, 'cursor.db');

  // Create tmp directory if needed
  await mkdir(tmpDir, { recursive: true });

  // Copy the database file
  console.log(`Copying Cursor DB from ${srcPath} to ${destPath}...`);
  await copyFile(srcPath, destPath);

  // Also copy WAL files if they exist (SQLite write-ahead log)
  const walPath = `${srcPath}-wal`;
  const shmPath = `${srcPath}-shm`;

  if (existsSync(walPath)) {
    await copyFile(walPath, `${destPath}-wal`);
  }
  if (existsSync(shmPath)) {
    await copyFile(shmPath, `${destPath}-shm`);
  }

  console.log('Cursor DB copied successfully');
  return destPath;
}

// Extract workspace path from conversation context
async function extractWorkspacePath(conversationId: string): Promise<string | null> {
  try {
    // Query raw conversation data to get context
    const rows = await queryAll<{ key: string; value: string }>(`
      SELECT value
      FROM cursorDiskKV
      WHERE key = 'composerData:${conversationId}'
      AND value IS NOT NULL
      AND value != 'null'
      LIMIT 1
    `);

    if (rows.length === 0) return null;

    const data = JSON.parse(rows[0].value);
    const context = data.context;

    if (!context) return null;

    // Try to extract workspace from file selections
    if (context.fileSelections && Array.isArray(context.fileSelections)) {
      for (const selection of context.fileSelections) {
        const fsPath = selection.uri?.fsPath;
        if (fsPath && typeof fsPath === 'string') {
          // Extract a reasonable workspace path (go up to a common ancestor)
          // E.g., /Users/hypnodroid/Projects/sibi/habitat/agent/src/app.tsx
          // becomes sibi/habitat or similar
          const parts = fsPath.split('/').filter(Boolean);

          // Find common workspace patterns
          const projectsIndex = parts.indexOf('Projects');
          if (projectsIndex >= 0 && projectsIndex + 2 < parts.length) {
            // Return something like "sibi/habitat"
            return `${parts[projectsIndex + 1]}/${parts[projectsIndex + 2]}`;
          }

          // Fallback: use last 2-3 directory components before filename
          if (parts.length >= 3) {
            const dirParts = parts.slice(0, -1); // Remove filename
            if (dirParts.length >= 2) {
              return dirParts.slice(-2).join('/');
            }
          }
        }
      }
    }

    // Try folder selections
    if (context.folderSelections && Array.isArray(context.folderSelections)) {
      for (const selection of context.folderSelections) {
        const fsPath = selection.uri?.fsPath;
        if (fsPath && typeof fsPath === 'string') {
          const parts = fsPath.split('/').filter(Boolean);
          const projectsIndex = parts.indexOf('Projects');
          if (projectsIndex >= 0 && projectsIndex + 2 < parts.length) {
            return `${parts[projectsIndex + 1]}/${parts[projectsIndex + 2]}`;
          }
          if (parts.length >= 2) {
            return parts.slice(-2).join('/');
          }
        }
      }
    }

    return null;
  } catch (e) {
    console.error(`Failed to extract workspace for ${conversationId}:`, e);
    return null;
  }
}

// Extract text content from a Cursor message
// The cursor-conversations library now handles richText, codeBlocks, toolFormerData, etc.
// This function just provides a fallback for edge cases
function extractMessageText(message: any): string {
  return message.text || '';
}

// Main sync function for Cursor
export async function syncCursor(options?: { incremental?: boolean }): Promise<CursorSyncStats> {
  const stats: CursorSyncStats = {
    conversationsProcessed: 0,
    messagesInserted: 0,
    skipped: 0,
    errors: [],
  };

  // Copy database to avoid lock conflicts
  let dbPath: string;
  try {
    dbPath = await copyCursorDb();
    setDatabasePath(dbPath);
  } catch (e) {
    const error = `Failed to copy Cursor database: ${e}`;
    console.error(error);
    stats.errors.push(error);
    return stats;
  }

  console.log('Syncing Cursor conversations...');

  // Get source ID
  const source = await queries.getSourceByName('cursor');
  if (!source) {
    stats.errors.push('Cursor source not found in database');
    return stats;
  }

  // Incremental sync checks each conversation's updatedAt against stored file_modified_at

  try {
    // List all conversations
    const { conversations, total } = await listConversations({
      sortBy: 'recent_activity',
      sortOrder: 'desc',
      limit: 1000,
    });

    console.log(`Found ${total} Cursor conversations`);

    // Cache for project IDs to avoid repeated upserts
    const projectCache = new Map<string, number>();

    for (const conv of conversations) {
      try {
        // Extract workspace path for this conversation
        const workspacePath = await extractWorkspacePath(conv.conversationId);
        const projectSlug = workspacePath || 'cursor-unknown';
        const projectName = workspacePath || 'Unknown Workspace';

        // Get or create project ID (with caching)
        let projectId = projectCache.get(projectSlug);
        if (!projectId) {
          projectId = await queries.upsertProject(
            source.id,
            projectSlug,
            projectSlug,
            `Cursor: ${projectName}`
          );
          projectCache.set(projectSlug, projectId);
        }

        // TypeScript doesn't know projectId is defined after the if check
        let definiteProjectId: number = projectId;

        // Check if session exists GLOBALLY across all projects (prevents duplicates)
        const existingGlobal = await queries.getSessionByExternalIdGlobal(source.id, conv.conversationId);

        if (existingGlobal) {
          // Session already exists - use its existing project assignment to prevent duplicates
          definiteProjectId = existingGlobal.project_id;

          // Incremental mode: skip if session hasn't been updated
          if (options?.incremental) {
            const storedModifiedAt = existingGlobal.file_modified_at?.getTime() ?? 0;
            if (conv.updatedAt <= storedModifiedAt) {
              stats.skipped++;
              continue;
            }
            console.log(`  Re-syncing ${conv.conversationId}: updatedAt ${conv.updatedAt} > stored ${storedModifiedAt}`);
          }
        }

        // Get full conversation with messages
        const { messages } = await listMessages(conv.conversationId, { limit: 500 });

        // Compute session timestamps from conversation dates
        // Use createdAt as start, updatedAt as end
        const startedAt = new Date(conv.createdAt)
        const endedAt = new Date(conv.updatedAt)

        // Upsert session
        const sessionId = await queries.upsertSession({
          projectId: definiteProjectId,
          externalId: conv.conversationId,
          title: conv.preview?.slice(0, 100) || 'Untitled',
          fileModifiedAt: new Date(conv.updatedAt),
          startedAt,
          endedAt,
        });

        // Insert messages and track total content size
        let sequenceNum = 0;
        let totalContentChars = 0;
        let skippedCount = 0;
        for (const message of messages) {
          const contentText = extractMessageText(message);
          if (!contentText) {
            skippedCount++;
            if (skippedCount === 1) {
              console.log(`Skipping message with no text. message.text=${message.text}, messageId=${message.messageId}`);
            }
            continue;
          }

          totalContentChars += contentText.length;
          const role = message.type === 1 ? 'user' : 'assistant';

          const msgId = await queries.insertMessage({
            sessionId,
            externalId: message.messageId,
            role,
            contentText,
            contentJson: message,
            timestamp: new Date(conv.createdAt),
            sequenceNum: sequenceNum++,
          });

          if (msgId) stats.messagesInserted++;
        }
        if (skippedCount > 0) {
          console.log(`Conversation ${conv.conversationId}: Processed ${messages.length} messages, inserted ${stats.messagesInserted - (stats.messagesInserted - messages.length + skippedCount)}, skipped ${skippedCount}`);
        }

        // Update session stats and content_chars
        await queries.updateSessionStats(sessionId);
        await queries.updateSessionContentChars(sessionId);

        stats.conversationsProcessed++;

        if (stats.conversationsProcessed % 50 === 0) {
          console.log(`Processed ${stats.conversationsProcessed} Cursor conversations...`);
        }
      } catch (e) {
        const error = `Failed to sync Cursor conversation ${conv.conversationId}: ${e}`;
        console.error(error);
        stats.errors.push(error);
      }
    }
  } catch (e) {
    const error = `Failed to list Cursor conversations: ${e}`;
    console.error(error);
    stats.errors.push(error);
  }

  // Update sync state
  await queries.updateSyncState(
    source.id,
    'sessions',
    stats.conversationsProcessed,
    stats.messagesInserted,
    stats.errors.length > 0 ? stats.errors.join('; ') : undefined
  );

  console.log(
    `Cursor sync complete: ${stats.conversationsProcessed} conversations, ${stats.messagesInserted} messages`
  );

  return stats;
}
