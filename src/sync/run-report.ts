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
  lines.push(
    `  History: ${result.history.entries} entries ` +
      `(${result.history.malformedLines} malformed, ${result.history.invalidTimestamps} unusable timestamps)`
  );
  lines.push(`  Embeddings: ${result.embeddings.messagesEmbedded} embedded`);

  // Explicitly NOT an error, and it must not become one: a stood-down cycle
  // exits 0, or the container loop reports a button someone pressed on purpose
  // as a failing sync. It is called out anyway, because a cycle that embedded
  // almost nothing needs to say which of the two it was.
  if (result.stoodDown) {
    lines.push(
      '  Stood down: ingestion was asked to stop, so this cycle ended early. ' +
        'Nothing was lost — the remaining work is still pending and the next scheduled cycle takes it.'
    );
  }

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
