import { describe, it, expect } from 'vitest';
import { buildRunReport } from './run-report.js';
import type { FullSyncResult } from './orchestrator.js';

const result = (over: Partial<FullSyncResult> = {}): FullSyncResult => ({
  startTime: new Date('2026-08-01T00:00:00Z'),
  endTime: new Date('2026-08-01T00:01:00Z'),
  durationMs: 60_000,
  claudeCode: {
    projectsProcessed: 3,
    sessionsProcessed: 12,
    messagesInserted: 340,
    skipped: 96,
    quarantined: 0,
  },
  history: { entries: 0, malformedLines: 0, invalidTimestamps: 0 },
  spool: { configured: false, drained: 0, quarantined: 0 },
  embeddings: { messagesEmbedded: 100, sessionsUpdated: 5 },
  standDown: false,
  errors: [],
  ...over,
});

describe('buildRunReport exit code', () => {
  // The whole point of #29: a run that recorded errors must not look like a
  // success to whatever is watching the process.
  it('is nonzero when any error was recorded', () => {
    const report = buildRunReport(
      result({ errors: ['Failed to sync session /a/b.jsonl: boom'] })
    );
    expect(report.exitCode).toBe(1);
  });

  it('is zero for a clean run', () => {
    expect(buildRunReport(result()).exitCode).toBe(0);
  });

  // Quarantine is the designed holding pen — data waiting, not lost — so it
  // must not fail the run, or every replayable record would page someone.
  it('is zero when records were quarantined but nothing errored', () => {
    const report = buildRunReport(
      result({
        claudeCode: {
          projectsProcessed: 1,
          sessionsProcessed: 1,
          messagesInserted: 10,
          skipped: 0,
          quarantined: 2,
        },
      })
    );
    expect(report.exitCode).toBe(0);
  });
});

describe('buildRunReport summary', () => {
  it('includes skipped and quarantined counts', () => {
    const text = buildRunReport(
      result({
        claudeCode: {
          projectsProcessed: 1,
          sessionsProcessed: 1,
          messagesInserted: 10,
          skipped: 7,
          quarantined: 2,
        },
      })
    ).lines.join('\n');
    expect(text).toContain('7 skipped');
    expect(text).toContain('2 quarantined');
    expect(text).toContain('sync_quarantine');
  });

  // The history parser's skip counters must reach the operator, not just a
  // warn inside the sync — this is where they surface.
  it('carries the history skip counters', () => {
    const text = buildRunReport(
      result({ history: { entries: 40, malformedLines: 2, invalidTimestamps: 1 } })
    ).lines.join('\n');
    expect(text).toContain('History: 40 entries (2 malformed, 1 unusable timestamps)');
  });

  // A machine with no spool env set is a normal machine, not an idle one, so
  // the report says nothing about a spool rather than printing a zero.
  it('says nothing about the ingest spool when none is configured', () => {
    const text = buildRunReport(result()).lines.join('\n');
    expect(text).not.toContain('Ingest spool');
  });

  it('reports what the ingest spool drained when one is configured', () => {
    const text = buildRunReport(
      result({ spool: { configured: true, drained: 4, quarantined: 0 } })
    ).lines.join('\n');
    // The spool line carries a quarantine count only when there is one to
    // carry — a bare "0 quarantined" is noise on every clean run.
    expect(text).toContain('Ingest spool: 4 drained');
    expect(text).not.toContain('Ingest spool: 4 drained,');
  });

  // Spooled payloads land in the same holding pen as file-sync records, so the
  // one number an operator watches has to count both — a spool quarantine that
  // only shows on the spool line is data waiting where nobody is looking.
  it('counts spool quarantines in the total kept in sync_quarantine', () => {
    const text = buildRunReport(
      result({
        claudeCode: {
          projectsProcessed: 1,
          sessionsProcessed: 1,
          messagesInserted: 10,
          skipped: 0,
          quarantined: 1,
        },
        spool: { configured: true, drained: 4, quarantined: 2 },
      })
    ).lines.join('\n');
    expect(text).toContain('Ingest spool: 4 drained, 2 quarantined');
    expect(text).toContain('Quarantined: 3 record(s)');
  });

  // Quarantine is the designed holding pen on this path too: spooled payloads
  // waiting for a replay must not make the run exit nonzero.
  it('still exits zero when only the spool quarantined something', () => {
    const report = buildRunReport(
      result({ spool: { configured: true, drained: 0, quarantined: 2 } })
    );
    expect(report.exitCode).toBe(0);
  });

  // Errors were previously only visible as a count in logs nobody read; the
  // summary must carry every error verbatim, untruncated.
  it('lists every error in full', () => {
    const long = `Failed to sync session /very/long/path/${'x'.repeat(500)}.jsonl: kaboom`;
    const text = buildRunReport(result({ errors: [long, 'second error'] })).lines.join('\n');
    expect(text).toContain(long);
    expect(text).toContain('second error');
    expect(text).toContain('Errors: 2');
  });
});
