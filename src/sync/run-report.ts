import type { FullSyncResult } from './orchestrator.js';

// The per-run verdict, as one pure function so the exit-code contract is
// testable without a database: a run that recorded any error exits nonzero,
// so container-level monitoring (`while true; pnpm run sync; sleep`) can see
// a failing run instead of an eternal exit 0. Quarantined records do NOT fail
// the run — they are kept, counted, and waiting for replay, which is the
// designed path — but they are always printed so nonzero never hides.
export interface RunReport {
  lines: string[];
  exitCode: 0 | 1;
}

export function buildRunReport(result: FullSyncResult): RunReport {
  const lines: string[] = [];

  lines.push('='.repeat(60));
  lines.push('Sync Summary:');
  lines.push(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push(
    `  Claude Code: ${result.claudeCode.projectsProcessed} projects, ` +
      `${result.claudeCode.sessionsProcessed} sessions, ` +
      `${result.claudeCode.messagesInserted} messages ` +
      `(${result.claudeCode.skipped} skipped, ${result.claudeCode.quarantined} quarantined)`
  );
  lines.push(`  Embeddings: ${result.embeddings.messagesEmbedded} embedded`);

  const quarantined = result.claudeCode.quarantined;
  if (quarantined > 0) {
    lines.push(
      `  Quarantined: ${quarantined} record(s) kept in sync_quarantine — waiting, not lost. ` +
        `Inspect with \`pnpm run quarantine\`, replay with \`pnpm run quarantine -- --retry\`.`
    );
  }

  if (result.errors.length > 0) {
    lines.push(`  Errors: ${result.errors.length}`);
    for (const error of result.errors) {
      lines.push(`    - ${error}`);
    }
  }
  lines.push('='.repeat(60));

  return { lines, exitCode: result.errors.length > 0 ? 1 : 0 };
}
