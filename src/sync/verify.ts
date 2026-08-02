import { config } from '../config.js';
import { query, queries } from '../db/postgres.js';
import {
  parseClaudeSessionFile,
  decodeProjectPath,
} from '../parsers/claude-messages.js';
import { discoverProjects, discoverSessionFiles } from './claude-code.js';

// `verify` answers the question sync itself cannot: does the database actually
// hold what the files on disk hold? It walks every session file, parses it with
// the same parser sync uses, and compares three numbers per session:
//
//   parsed   — distinct message uuids in the file (distinct, because inserts
//              are ON CONFLICT DO NOTHING: a uuid repeated in the file is one
//              row, correctly)
//   stored   — actual rows in `messages` for that session
//   counted  — `sessions.message_count`, the denormalized stat
//
// plus the records legitimately waiting in `sync_quarantine` — those are
// accounted for, not missing (issue #29: quarantined means waiting, not lost).

// The per-session judgment, pure so it can be tested without a database.
export interface SessionCounts {
  parsed: number;
  stored: number;
  counted: number;
  quarantinedPending: number;
}

export type Drift =
  | { kind: 'none' }
  // File has messages the DB does not, beyond what quarantine accounts for.
  | { kind: 'missing-rows'; missing: number }
  // Rows are all there but the denormalized stat disagrees — the stale-stats
  // variant from issue #21 (stored nonzero count, never recomputed).
  | { kind: 'stale-stats' }
  // The DB somehow has more rows than the file — worth surfacing, never hiding.
  | { kind: 'surplus-rows'; surplus: number };

export function assessSession(c: SessionCounts): Drift {
  const accounted = c.stored + c.quarantinedPending;
  if (accounted < c.parsed) return { kind: 'missing-rows', missing: c.parsed - accounted };
  if (c.stored > c.parsed) return { kind: 'surplus-rows', surplus: c.stored - c.parsed };
  if (c.counted !== c.stored) return { kind: 'stale-stats' };
  return { kind: 'none' };
}

export interface SessionDriftReport {
  filePath: string;
  externalId: string;
  sessionId: number | null; // null: file exists but the DB has no session row
  projectPath: string;
  counts: SessionCounts;
  drift: Drift;
  repaired: boolean;
}

export interface VerifyResult {
  filesChecked: number;
  matched: number;
  // Session files the DB has never seen. Not drift — the next sync will pick
  // them up — but reported so the summary accounts for every file.
  neverSynced: number;
  // Sessions whose file changed since their last sync: the DB is legitimately
  // behind and the next incremental run will reprocess them. Issue #21's
  // dangerous case is exactly the opposite — `will_resync = false` — so only
  // that case counts as drift.
  pendingSync: number;
  drifted: SessionDriftReport[];
  repaired: number;
  errors: string[];
}

async function countStoredMessages(sessionId: number): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM messages WHERE session_id = $1',
    [sessionId]
  );
  return parseInt(result.rows[0].count, 10);
}

async function countQuarantinedPending(sessionId: number): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM sync_quarantine WHERE session_id = $1 AND resolved_at IS NULL',
    [sessionId]
  );
  return parseInt(result.rows[0].count, 10);
}

// Repair = clear the incremental-sync stamp so the next sync reprocesses the
// file (inserts are ON CONFLICT DO NOTHING, so existing rows do not duplicate),
// and recompute the denormalized stats right now so the stale-stats variant is
// fixed without waiting for that sync.
async function repairSession(sessionId: number): Promise<void> {
  await query('UPDATE sessions SET file_modified_at = NULL WHERE id = $1', [sessionId]);
  await queries.updateSessionStats(sessionId);
  await queries.updateSessionContentChars(sessionId);
}

export async function verifyClaudeCode(options?: {
  repair?: boolean;
  projectFilter?: string;
}): Promise<VerifyResult> {
  const result: VerifyResult = {
    filesChecked: 0,
    matched: 0,
    neverSynced: 0,
    pendingSync: 0,
    drifted: [],
    repaired: 0,
    errors: [],
  };

  const basePath = config.sources.claudeCode.path;
  const source = await queries.getSourceByName('claude_code');
  if (!source) {
    result.errors.push('Claude Code source not found in database');
    return result;
  }

  const projectPaths = await discoverProjects(basePath);
  console.log(`Verifying ${projectPaths.length} projects under ${basePath}...`);

  for (const projectPath of projectPaths) {
    const projectDirName = projectPath.split('/').pop()!;
    const decodedPath = decodeProjectPath(projectDirName);

    if (options?.projectFilter && !decodedPath.includes(options.projectFilter)) {
      continue;
    }

    const sessionFiles = await discoverSessionFiles(projectPath);

    for (const sessionFile of sessionFiles) {
      try {
        const parsed = await parseClaudeSessionFile(sessionFile);
        if (!parsed) continue; // empty file: nothing to hold, nothing to verify

        result.filesChecked++;

        // Distinct uuids: what a complete sync would have produced as rows.
        const parsedCount = new Set(parsed.messages.map((m) => m.uuid)).size;

        // The session row can live under a corrected project (sync rewrites the
        // project path from cwd), so look the session up by external id across
        // the whole source, exactly as a re-sync would find it.
        const existing = await queries.getSessionByExternalIdGlobal(
          source.id,
          parsed.sessionId
        );

        if (!existing) {
          result.neverSynced++;
          continue;
        }

        const counts: SessionCounts = {
          parsed: parsedCount,
          stored: await countStoredMessages(existing.id),
          counted: existing.message_count,
          quarantinedPending: await countQuarantinedPending(existing.id),
        };

        const drift = assessSession(counts);
        if (drift.kind === 'none') {
          result.matched++;
          continue;
        }

        // If the file changed since its last sync, the next incremental run
        // will reprocess it and fix missing rows and stale stats alike —
        // reporting that as drift would page someone for the normal case of a
        // conversation still being written. Surplus rows are never fixed by a
        // re-sync, so they stay drift regardless.
        const willResync =
          !existing.file_modified_at ||
          existing.file_modified_at.getTime() !== parsed.fileModifiedAt.getTime();
        if (willResync && drift.kind !== 'surplus-rows') {
          result.pendingSync++;
          continue;
        }

        let repaired = false;
        if (options?.repair) {
          await repairSession(existing.id);
          result.repaired++;
          repaired = true;
        }

        result.drifted.push({
          filePath: sessionFile,
          externalId: parsed.sessionId,
          sessionId: existing.id,
          projectPath: parsed.cwd ?? decodedPath,
          counts,
          drift,
          repaired,
        });
      } catch (e) {
        result.errors.push(`Failed to verify ${sessionFile}: ${e}`);
      }
    }
  }

  return result;
}

const describeDrift = (drift: Drift): string => {
  switch (drift.kind) {
    case 'missing-rows':
      return `${drift.missing} message(s) in file but not in DB (and not in quarantine)`;
    case 'surplus-rows':
      return `${drift.surplus} more row(s) in DB than in file`;
    case 'stale-stats':
      return 'sessions.message_count disagrees with actual rows';
    case 'none':
      return 'no drift';
  }
};

// Render the result for the terminal. Full paths and ids, never truncated —
// the output exists so a human or a script can act on specific sessions.
export function formatVerifyReport(result: VerifyResult, repair: boolean): string[] {
  const lines: string[] = [];

  for (const d of result.drifted) {
    lines.push(
      `DRIFT session ${d.sessionId} (${d.externalId})` +
        `\n  file: ${d.filePath}` +
        `\n  project: ${d.projectPath}` +
        `\n  parsed=${d.counts.parsed} stored=${d.counts.stored} ` +
        `message_count=${d.counts.counted} quarantined_pending=${d.counts.quarantinedPending}` +
        `\n  ${describeDrift(d.drift)}` +
        (d.repaired
          ? '\n  repaired: file_modified_at cleared, stats recomputed — next incremental sync reprocesses the file'
          : '')
    );
  }

  lines.push('='.repeat(60));
  lines.push('Verify Summary:');
  lines.push(`  Files checked: ${result.filesChecked}`);
  lines.push(`  Matched: ${result.matched}`);
  lines.push(`  Never synced (new files awaiting sync): ${result.neverSynced}`);
  lines.push(`  Pending sync (file changed since last sync): ${result.pendingSync}`);
  lines.push(`  Drifted: ${result.drifted.length}`);
  if (repair) lines.push(`  Repaired: ${result.repaired}`);
  if (result.errors.length > 0) {
    lines.push(`  Errors: ${result.errors.length}`);
    for (const error of result.errors) lines.push(`    - ${error}`);
  }
  if (result.drifted.length > 0 && !repair) {
    lines.push('  Run again with --repair to clear the sync stamp on drifted sessions.');
  }
  lines.push('='.repeat(60));

  return lines;
}

// Exit contract: drift that was not repaired is a failure; drift that was
// repaired is a handled condition; verification errors are always failures.
export function verifyExitCode(result: VerifyResult, repaired: boolean): 0 | 1 {
  if (result.errors.length > 0) return 1;
  if (result.drifted.length > 0 && !repaired) return 1;
  return 0;
}
