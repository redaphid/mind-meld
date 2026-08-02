import pg from 'pg';
import { config } from '../config.js';
import { isAutomated } from '../embeddings/classify.js';
import { normalizeText, normalizeDeep } from '../utils/text-encoding.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      user: config.postgres.user,
      password: config.postgres.password,
      database: config.postgres.database,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err);
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const pool = getPool();
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;

  if (config.logLevel === 'debug') {
    console.log('Executed query', { text: text.slice(0, 100), duration, rows: result.rowCount });
  }

  return result;
}

export async function getClient(): Promise<pg.PoolClient> {
  const pool = getPool();
  return pool.connect();
}

export async function transaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// Postgres stores no U+0000 — not in text, not in jsonb values or keys — and
// rejects the whole INSERT with 'invalid byte sequence for encoding "UTF8":
// 0x00'; lone surrogates fail the same way. Transcripts hit this legitimately:
// WSL tools (`wsl --list`) emit UTF-16 output that Claude Code records
// faithfully as escaped \u0000 inside otherwise valid JSON, and one such line
// used to fail an entire session's sync. Removing the NULs IS the decode for
// that corruption class; normalizeText drops only what Postgres cannot store — see
// src/utils/text-encoding.ts. Every text parameter below goes through it, so
// every write path (file sync, /api/ingest, quarantine replay) is protected
// regardless of which machine or code version produced the data.
const clean = (value: string | undefined | null): string | null =>
  value === undefined || value === null ? null : normalizeText(value);

// Normalises the whole tree — values and keys — before serialisation, so a
// genuine literal "\\u0000" in the text is left alone; only real NUL
// characters and lone surrogates are repaired.
const toJson = (value: object | undefined): string | null =>
  value === undefined ? null : JSON.stringify(normalizeDeep(value));

// Query builders for common operations
export const queries = {
  // Sources
  getSourceByName: async (name: string) => {
    const result = await query<{ id: number; name: string; base_path: string }>(
      'SELECT id, name, base_path FROM sources WHERE name = $1',
      [name]
    );
    return result.rows[0] ?? null;
  },

  // A brand-new source lands as 'personal' unless the caller classifies it —
  // fail closed: unclassified data stays invisible to the default search.
  // dataClass stamps NEW sources only. On conflict data_class is deliberately
  // NOT updated: /api/ingest is unauthenticated, and letting it reclassify an
  // existing source (android → coding) would defeat the class filter in one
  // POST. Reclassification, if ever wanted, needs its own deliberate, logged
  // endpoint.
  getOrCreateSource: async (name: string, displayName?: string, dataClass?: string) => {
    const result = await query<{ id: number; name: string; data_class: string }>(
      `INSERT INTO sources (name, display_name, data_class)
       VALUES ($1, $2, COALESCE($3, 'personal'))
       ON CONFLICT (name) DO UPDATE SET name = $1
       RETURNING id, name, data_class`,
      [name, displayName ?? name, dataClass ?? null]
    );
    return result.rows[0];
  },

  // Projects
  // `machine` defaults to whoever is running this process, which is what every
  // sync wants. Callers relaying someone else's data (/api/ingest) pass the
  // sender's machine, or null when it is unknown — null preserves whatever was
  // already recorded rather than overwriting a known origin with a guess.
  upsertProject: async (
    sourceId: number,
    externalId: string,
    path: string,
    name: string,
    machine: string | null = config.machine
  ) => {
    const result = await query<{ id: number }>(
      `INSERT INTO projects (source_id, external_id, path, name, machine, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (source_id, external_id)
       DO UPDATE SET path = $3, name = $4,
                     machine = COALESCE($5, projects.machine),
                     last_synced_at = NOW()
       RETURNING id`,
      [sourceId, normalizeText(externalId), normalizeText(path), normalizeText(name), clean(machine)]
    );
    return result.rows[0].id;
  },

  getProjectByExternalId: async (sourceId: number, externalId: string) => {
    const result = await query<{ id: number; path: string; name: string }>(
      'SELECT id, path, name FROM projects WHERE source_id = $1 AND external_id = $2',
      [sourceId, externalId]
    );
    return result.rows[0] ?? null;
  },

  // Sessions
  upsertSession: async (params: {
    projectId: number;
    externalId: string;
    title?: string;
    isAgent?: boolean;
    parentSessionId?: number;
    agentId?: string;
    claudeVersion?: string;
    modelUsed?: string;
    gitBranch?: string;
    cwd?: string;
    rawFilePath?: string;
    fileModifiedAt?: Date;
    startedAt?: Date;
    endedAt?: Date;
  }) => {
    const result = await query<{ id: number }>(
      `INSERT INTO sessions (
        project_id, external_id, title, is_agent, parent_session_id, agent_id,
        claude_version, model_used, git_branch, cwd, raw_file_path, file_modified_at,
        started_at, ended_at, is_automated, last_synced_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
      ON CONFLICT (project_id, external_id)
      DO UPDATE SET
        title = COALESCE($3, sessions.title),
        model_used = COALESCE($8, sessions.model_used),
        file_modified_at = $12,
        started_at = COALESCE($13, sessions.started_at),
        ended_at = COALESCE($14, sessions.ended_at),
        is_automated = $15,
        last_synced_at = NOW()
      RETURNING id`,
      [
        params.projectId,
        normalizeText(params.externalId),
        clean(params.title),
        params.isAgent ?? false,
        params.parentSessionId ?? null,
        clean(params.agentId),
        clean(params.claudeVersion),
        clean(params.modelUsed),
        clean(params.gitBranch),
        clean(params.cwd),
        clean(params.rawFilePath),
        params.fileModifiedAt ?? null,
        params.startedAt ?? null,
        params.endedAt ?? null,
        isAutomated(clean(params.title)),
      ]
    );
    return result.rows[0].id;
  },

  getSessionByExternalId: async (projectId: number, externalId: string) => {
    const result = await query<{
      id: number;
      file_modified_at: Date | null;
      content_chars: number;
      message_count: number;
    }>(
      'SELECT id, file_modified_at, content_chars, message_count FROM sessions WHERE project_id = $1 AND external_id = $2',
      [projectId, externalId]
    );
    return result.rows[0] ?? null;
  },

  // Check for session by external_id across ALL projects for a source (for deduplication)
  getSessionByExternalIdGlobal: async (sourceId: number, externalId: string) => {
    const result = await query<{
      id: number;
      project_id: number;
      file_modified_at: Date | null;
      content_chars: number;
      message_count: number;
    }>(
      `SELECT s.id, s.project_id, s.file_modified_at, s.content_chars, s.message_count
       FROM sessions s
       JOIN projects p ON s.project_id = p.id
       WHERE p.source_id = $1 AND s.external_id = $2`,
      [sourceId, externalId]
    );
    return result.rows[0] ?? null;
  },

  // Get the latest file_modified_at across all sessions for a source (for incremental sync)
  getLatestFileModified: async (sourceId: number): Promise<Date | null> => {
    const result = await query<{ max_modified: Date | null }>(
      `SELECT MAX(s.file_modified_at) as max_modified
       FROM sessions s
       JOIN projects p ON s.project_id = p.id
       WHERE p.source_id = $1`,
      [sourceId]
    );
    return result.rows[0]?.max_modified ?? null;
  },

  // Update content_chars for a session (sum of all message content lengths)
  updateSessionContentChars: async (sessionId: number) => {
    await query(
      `UPDATE sessions SET content_chars = COALESCE(
        (SELECT SUM(LENGTH(content_text)) FROM messages WHERE session_id = $1 AND content_text IS NOT NULL),
        0
      ) WHERE id = $1`,
      [sessionId]
    );
  },

  // Get session content chars
  getSessionContentChars: async (sessionId: number): Promise<number> => {
    const result = await query<{ content_chars: number }>(
      'SELECT content_chars FROM sessions WHERE id = $1',
      [sessionId]
    );
    return result.rows[0]?.content_chars ?? 0;
  },

  // Messages
  insertMessage: async (params: {
    sessionId: number;
    externalId: string;
    parentMessageId?: number;
    role: string;
    contentText?: string;
    contentJson?: object;
    toolName?: string;
    toolInput?: object;
    toolResult?: string;
    thinkingText?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    timestamp: Date;
    sequenceNum?: number;
    isSidechain?: boolean;
  }) => {
    const result = await query<{ id: number }>(
      `INSERT INTO messages (
        session_id, external_id, parent_message_id, role, content_text, content_json,
        tool_name, tool_input, tool_result, thinking_text, model,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        timestamp, sequence_num, is_sidechain
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (session_id, external_id) DO NOTHING
      RETURNING id`,
      [
        params.sessionId,
        normalizeText(params.externalId),
        params.parentMessageId ?? null,
        params.role,
        clean(params.contentText),
        toJson(params.contentJson),
        clean(params.toolName),
        toJson(params.toolInput),
        clean(params.toolResult),
        clean(params.thinkingText),
        clean(params.model),
        params.inputTokens ?? null,
        params.outputTokens ?? null,
        params.cacheCreationTokens ?? null,
        params.cacheReadTokens ?? null,
        params.timestamp,
        params.sequenceNum ?? null,
        params.isSidechain ?? false,
      ]
    );
    return result.rows[0]?.id ?? null;
  },

  // Update session stats
  updateSessionStats: async (sessionId: number) => {
    await query('SELECT update_session_stats($1::integer)', [sessionId]);
  },

  // Sync state
  getSyncState: async (sourceId: number, entityType: string) => {
    const result = await query<{
      last_sync_timestamp: Date | null;
      last_file_modified: Date | null;
      files_processed: number;
      records_synced: number;
    }>(
      'SELECT last_sync_timestamp, last_file_modified, files_processed, records_synced FROM sync_state WHERE source_id = $1 AND entity_type = $2',
      [sourceId, entityType]
    );
    return result.rows[0] ?? null;
  },

  updateSyncState: async (
    sourceId: number,
    entityType: string,
    filesProcessed: number,
    recordsSynced: number,
    lastError?: string,
    lastFileModified?: Date
  ) => {
    await query(
      `INSERT INTO sync_state (source_id, entity_type, last_sync_timestamp, files_processed, records_synced, last_error, last_file_modified, updated_at)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, NOW())
       ON CONFLICT (source_id, entity_type)
       DO UPDATE SET
         last_sync_timestamp = NOW(),
         files_processed = sync_state.files_processed + $3,
         records_synced = sync_state.records_synced + $4,
         last_error = $5,
         last_file_modified = COALESCE($6, sync_state.last_file_modified),
         updated_at = NOW()`,
      [sourceId, entityType, filesProcessed, recordsSynced, clean(lastError), lastFileModified ?? null]
    );
  },

  // Search
  searchMessages: async (searchQuery: string, limit = 50, sourceFilter?: string) => {
    return query(
      'SELECT * FROM search_messages($1, $2, $3)',
      [searchQuery, limit, sourceFilter ?? null]
    );
  },
};
