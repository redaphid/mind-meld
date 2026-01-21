import { syncClaudeCode, syncClaudeHistory } from './claude-code.js';
import { syncCursor } from './cursor.js';
import { syncHuddles } from './huddle.js';
import { generatePendingEmbeddings, updateAggregateEmbeddings } from '../embeddings/batch.js';
import { query } from '../db/postgres.js';

export interface FullSyncResult {
  startTime: Date;
  endTime: Date;
  durationMs: number;
  claudeCode: {
    projectsProcessed: number;
    sessionsProcessed: number;
    messagesInserted: number;
  };
  cursor: {
    conversationsProcessed: number;
    messagesInserted: number;
  };
  huddle: {
    huddlesProcessed: number;
    messagesInserted: number;
  };
  embeddings: {
    messagesEmbedded: number;
    sessionsUpdated: number;
  };
  errors: string[];
}

export async function runFullSync(options?: {
  incremental?: boolean;
  skipEmbeddings?: boolean;
  sources?: ('claude_code' | 'cursor' | 'huddle')[];
}): Promise<FullSyncResult> {
  const startTime = new Date();
  const errors: string[] = [];

  console.log('='.repeat(60));
  console.log(`Starting full sync at ${startTime.toISOString()}`);
  console.log('='.repeat(60));

  const result: FullSyncResult = {
    startTime,
    endTime: new Date(),
    durationMs: 0,
    claudeCode: { projectsProcessed: 0, sessionsProcessed: 0, messagesInserted: 0 },
    cursor: { conversationsProcessed: 0, messagesInserted: 0 },
    huddle: { huddlesProcessed: 0, messagesInserted: 0 },
    embeddings: { messagesEmbedded: 0, sessionsUpdated: 0 },
    errors: [],
  };

  const sourcesToSync = options?.sources ?? ['claude_code', 'cursor', 'huddle'];

  // Sync Claude Code
  if (sourcesToSync.includes('claude_code')) {
    try {
      console.log('\n--- Syncing Claude Code ---');
      const claudeStats = await syncClaudeCode({ incremental: options?.incremental });
      result.claudeCode = {
        projectsProcessed: claudeStats.projectsProcessed,
        sessionsProcessed: claudeStats.sessionsProcessed,
        messagesInserted: claudeStats.messagesInserted,
      };
      errors.push(...claudeStats.errors);
    } catch (e) {
      const error = `Claude Code sync failed: ${e}`;
      console.error(error);
      errors.push(error);
    }
  }

  // Sync Cursor
  if (sourcesToSync.includes('cursor')) {
    try {
      console.log('\n--- Syncing Cursor ---');
      const cursorStats = await syncCursor({ incremental: options?.incremental });
      result.cursor = {
        conversationsProcessed: cursorStats.conversationsProcessed,
        messagesInserted: cursorStats.messagesInserted,
      };
      errors.push(...cursorStats.errors);
    } catch (e) {
      const error = `Cursor sync failed: ${e}`;
      console.error(error);
      errors.push(error);
    }
  }

  // Sync Huddles (Slack transcripts)
  if (sourcesToSync.includes('huddle')) {
    try {
      console.log('\n--- Syncing Slack Huddles ---');
      const huddleStats = await syncHuddles({ incremental: options?.incremental });
      result.huddle = {
        huddlesProcessed: huddleStats.huddlesProcessed,
        messagesInserted: huddleStats.messagesInserted,
      };
      errors.push(...huddleStats.errors);
    } catch (e) {
      const error = `Huddle sync failed: ${e}`;
      console.error(error);
      errors.push(error);
    }
  }

  // Generate embeddings
  if (!options?.skipEmbeddings) {
    try {
      console.log('\n--- Generating Embeddings ---');
      const embeddingStats = await generatePendingEmbeddings();
      result.embeddings.messagesEmbedded = embeddingStats.processed;

      console.log('\n--- Updating Aggregate Embeddings ---');
      const aggregateStats = await updateAggregateEmbeddings();
      result.embeddings.sessionsUpdated = aggregateStats.sessionsUpdated;
    } catch (e) {
      const error = `Embedding generation failed: ${e}`;
      console.error(error);
      errors.push(error);
    }
  }

  const endTime = new Date();
  result.endTime = endTime;
  result.durationMs = endTime.getTime() - startTime.getTime();
  result.errors = errors;

  console.log('\n' + '='.repeat(60));
  console.log('Sync Summary:');
  console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Claude Code: ${result.claudeCode.sessionsProcessed} sessions, ${result.claudeCode.messagesInserted} messages`);
  console.log(`  Cursor: ${result.cursor.conversationsProcessed} conversations, ${result.cursor.messagesInserted} messages`);
  console.log(`  Huddles: ${result.huddle.huddlesProcessed} huddles, ${result.huddle.messagesInserted} messages`);
  console.log(`  Embeddings: ${result.embeddings.messagesEmbedded} embedded`);
  if (errors.length > 0) {
    console.log(`  Errors: ${errors.length}`);
  }
  console.log('='.repeat(60));

  return result;
}

// Get sync status
export async function getSyncStatus(): Promise<{
  sources: {
    name: string;
    lastSync: Date | null;
    filesProcessed: number;
    recordsSynced: number;
    lastError: string | null;
  }[];
  totals: {
    projects: number;
    sessions: number;
    messages: number;
    embeddings: number;
  };
}> {
  const sourceStats = await query<{
    name: string;
    last_sync_timestamp: Date | null;
    files_processed: number;
    records_synced: number;
    last_error: string | null;
  }>(`
    SELECT s.name, ss.last_sync_timestamp, ss.files_processed, ss.records_synced, ss.last_error
    FROM sources s
    LEFT JOIN sync_state ss ON s.id = ss.source_id AND ss.entity_type = 'sessions'
  `);

  const totals = await query<{
    projects: string;
    sessions: string;
    messages: string;
    embeddings: string;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM projects)::text as projects,
      (SELECT COUNT(*) FROM sessions)::text as sessions,
      (SELECT COUNT(*) FROM messages)::text as messages,
      (SELECT COUNT(*) FROM embeddings)::text as embeddings
  `);

  return {
    sources: sourceStats.rows.map((r) => ({
      name: r.name,
      lastSync: r.last_sync_timestamp,
      filesProcessed: r.files_processed ?? 0,
      recordsSynced: r.records_synced ?? 0,
      lastError: r.last_error,
    })),
    totals: {
      projects: parseInt(totals.rows[0].projects, 10),
      sessions: parseInt(totals.rows[0].sessions, 10),
      messages: parseInt(totals.rows[0].messages, 10),
      embeddings: parseInt(totals.rows[0].embeddings, 10),
    },
  };
}
