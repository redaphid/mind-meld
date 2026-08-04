import { syncClaudeCode, syncClaudeHistory } from './claude-code.js';
import { generatePendingEmbeddings, updateAggregateEmbeddings, AGGREGATE_BATCH_SIZE } from '../embeddings/batch.js';
import { ensureEmbeddingModel } from '../embeddings/ollama.js';
import { ensureSummarizeModel } from '../embeddings/summarize.js';
import { query } from '../db/postgres.js';
import { shouldStandDown, STAND_DOWN_NOTICE } from './stand-down.js';

const MAX_AGGREGATE_DRAIN_MS = 50 * 60 * 1000;

export interface FullSyncResult {
  startTime: Date;
  endTime: Date;
  durationMs: number;
  claudeCode: {
    projectsProcessed: number;
    sessionsProcessed: number;
    messagesInserted: number;
    skipped: number;
    quarantined: number;
  };
  history: {
    entries: number;
    malformedLines: number;
    invalidTimestamps: number;
  };
  embeddings: {
    messagesEmbedded: number;
    sessionsUpdated: number;
  };
  // Someone asked ingestion to stand down and this cycle stopped early (or
  // never started). Not an error: the work is still pending and the next
  // scheduled cycle picks it up.
  stoodDown: boolean;
  errors: string[];
}

export async function runFullSync(options?: {
  incremental?: boolean;
  skipEmbeddings?: boolean;
  sources?: 'claude_code'[];
}): Promise<FullSyncResult> {
  const startTime = new Date();
  const errors: string[] = [];

  console.log('='.repeat(60));
  console.log(`Starting full sync at ${startTime.toISOString()}`);
  console.log('='.repeat(60));

  // Pull models to disk if not present (does NOT load into VRAM)
  try {
    await Promise.all([ensureEmbeddingModel(), ensureSummarizeModel()]);
    console.log('Models verified');
  } catch (e) {
    console.warn('Model pull check failed (non-fatal):', e);
  }

  const result: FullSyncResult = {
    startTime,
    endTime: new Date(),
    durationMs: 0,
    claudeCode: { projectsProcessed: 0, sessionsProcessed: 0, messagesInserted: 0, skipped: 0, quarantined: 0 },
    history: { entries: 0, malformedLines: 0, invalidTimestamps: 0 },
    embeddings: { messagesEmbedded: 0, sessionsUpdated: 0 },
    stoodDown: false,
    errors: [],
  };

  const sourcesToSync = options?.sources ?? ['claude_code'];

  // A cycle that starts inside the stand-down window skips outright. The window
  // is minutes and the interval is an hour, so this only ever catches the cycle
  // the press was aimed at -- pressing the button five seconds before the timer
  // fires should not be the one case where it does nothing.
  const finish = () => {
    const endTime = new Date();
    result.endTime = endTime;
    result.durationMs = endTime.getTime() - startTime.getTime();
    result.errors = errors;
    return result;
  };

  if (await shouldStandDown()) {
    console.log(STAND_DOWN_NOTICE);
    result.stoodDown = true;
    return finish();
  }

  // Sync Claude Code
  if (sourcesToSync.includes('claude_code')) {
    try {
      console.log('\n--- Syncing Claude Code ---');
      const claudeStats = await syncClaudeCode({ incremental: options?.incremental });
      result.claudeCode = {
        projectsProcessed: claudeStats.projectsProcessed,
        sessionsProcessed: claudeStats.sessionsProcessed,
        messagesInserted: claudeStats.messagesInserted,
        skipped: claudeStats.skipped,
        quarantined: claudeStats.quarantined,
      };
      errors.push(...claudeStats.errors);
    } catch (e) {
      const error = `Claude Code sync failed: ${e}`;
      console.error(error);
      errors.push(error);
    }

    // History (~/.claude/history.jsonl): parsed for its skip counters so a
    // malformed prompt-history line is counted, never silently continued (#29).
    try {
      const history = await syncClaudeHistory();
      result.history = {
        entries: history.entriesInserted,
        malformedLines: history.malformedLines,
        invalidTimestamps: history.invalidTimestamps,
      };
    } catch (e) {
      // No history file is a normal state (fresh machine, container without
      // the mount) — anything else is a real failure and counts as one.
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        const error = `Claude history sync failed: ${e}`;
        console.error(error);
        errors.push(error);
      }
    }
  }

  // Generate embeddings
  if (!options?.skipEmbeddings) {
    try {
      console.log('\n--- Generating Embeddings ---');
      const embeddingStats = await generatePendingEmbeddings();
      result.embeddings.messagesEmbedded = embeddingStats.processed;
      if (embeddingStats.stoodDown) result.stoodDown = true;

      console.log('\n--- Updating Aggregate Embeddings ---');
      // Drain the backlog batch-by-batch instead of one batch per sync cycle,
      // but stop after MAX_AGGREGATE_DRAIN_MS so new-message sync never starves
      const drainStart = Date.now();
      while (true) {
        const aggregateStats = await updateAggregateEmbeddings();
        result.embeddings.sessionsUpdated += aggregateStats.sessionsUpdated;
        if (aggregateStats.stoodDown) {
          result.stoodDown = true;
          break;
        }
        if (aggregateStats.sessionsFetched < AGGREGATE_BATCH_SIZE) break;
        if (Date.now() - drainStart > MAX_AGGREGATE_DRAIN_MS) {
          console.log('Aggregate drain time budget reached; remaining backlog resumes next cycle');
          break;
        }
      }
    } catch (e) {
      const error = `Embedding generation failed: ${e}`;
      console.error(error);
      errors.push(error);
    }
  }

  finish();

  // The per-run summary (and the exit-code verdict derived from it) lives in
  // buildRunReport; the CLI prints it so the report and the exit code cannot
  // drift apart.
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
