import { describe, it, expect, vi } from 'vitest';

// verify.ts imports the db module at load time; mock it so the pure logic can
// be tested without a database.
vi.mock('../db/postgres.js', () => ({ query: vi.fn(), queries: {} }));
vi.mock('../config.js', () => ({ config: { sources: { claudeCode: { path: '/nowhere' } } } }));

const { assessSession, verifyExitCode, formatVerifyReport } = await import('./verify.js');
import type { SessionCounts, VerifyResult, SessionDriftReport } from './verify.js';

const counts = (over: Partial<SessionCounts> = {}): SessionCounts => ({
  parsed: 100,
  stored: 100,
  counted: 100,
  quarantinedPending: 0,
  ...over,
});

describe('assessSession', () => {
  it('reports no drift when file, rows, and stats agree', () => {
    expect(assessSession(counts())).toEqual({ kind: 'none' });
  });

  // Issue #21 first variant: partial insert, then the file never re-syncs.
  it('reports missing rows when the DB holds fewer messages than the file', () => {
    expect(assessSession(counts({ stored: 44, counted: 44 }))).toEqual({
      kind: 'missing-rows',
      missing: 56,
    });
  });

  // Issue #21 second variant (sessions 222/110): rows stopped mid-resync but
  // the stale stat still looks plausible.
  it('reports stale stats when rows are complete but message_count disagrees', () => {
    expect(assessSession(counts({ counted: 0 }))).toEqual({ kind: 'stale-stats' });
  });

  // Quarantined records are waiting, not lost — a session whose only gap is
  // its quarantine backlog is accounted for, not drifted.
  it('does not count records pending in quarantine as missing', () => {
    expect(assessSession(counts({ stored: 98, counted: 98, quarantinedPending: 2 }))).toEqual({
      kind: 'none',
    });
  });

  it('still reports the gap quarantine does not cover', () => {
    expect(assessSession(counts({ stored: 90, counted: 90, quarantinedPending: 2 }))).toEqual({
      kind: 'missing-rows',
      missing: 8,
    });
  });

  it('reports surplus rows when the DB has more than the file', () => {
    expect(assessSession(counts({ stored: 105, counted: 105 }))).toEqual({
      kind: 'surplus-rows',
      surplus: 5,
    });
  });
});

const drifted = (over: Partial<SessionDriftReport> = {}): SessionDriftReport => ({
  filePath: '/home/u/.claude/projects/-home-u-p/abc.jsonl',
  externalId: 'abc',
  sessionId: 3422,
  projectPath: '/home/u/p',
  counts: counts({ stored: 44, counted: 0 }),
  drift: { kind: 'missing-rows', missing: 56 },
  repaired: false,
  ...over,
});

const verifyResult = (over: Partial<VerifyResult> = {}): VerifyResult => ({
  filesChecked: 10,
  matched: 9,
  neverSynced: 0,
  drifted: [],
  repaired: 0,
  errors: [],
  ...over,
});

describe('verifyExitCode', () => {
  it('is zero when nothing drifted', () => {
    expect(verifyExitCode(verifyResult({ matched: 10 }), false)).toBe(0);
  });

  // Unrepaired drift is the alarm this command exists to raise.
  it('is nonzero when drift was found and not repaired', () => {
    expect(verifyExitCode(verifyResult({ drifted: [drifted()] }), false)).toBe(1);
  });

  it('is zero when drift was found and repaired', () => {
    expect(
      verifyExitCode(verifyResult({ drifted: [drifted({ repaired: true })], repaired: 1 }), true)
    ).toBe(0);
  });

  it('is nonzero when verification itself errored, even under --repair', () => {
    expect(verifyExitCode(verifyResult({ errors: ['Failed to verify /a.jsonl: EACCES'] }), true)).toBe(1);
  });
});

describe('formatVerifyReport', () => {
  it('reports each drifted session with its full path and all four counts', () => {
    const text = formatVerifyReport(verifyResult({ drifted: [drifted()] }), false).join('\n');
    expect(text).toContain('/home/u/.claude/projects/-home-u-p/abc.jsonl');
    expect(text).toContain('session 3422');
    expect(text).toContain('parsed=100 stored=44 message_count=0 quarantined_pending=0');
    expect(text).toContain('Drifted: 1');
    expect(text).toContain('--repair');
  });

  // No Truncation Policy: a long file path must come through whole.
  it('never truncates paths', () => {
    const longPath = `/home/u/.claude/projects/${'-deep'.repeat(100)}/session.jsonl`;
    const text = formatVerifyReport(
      verifyResult({ drifted: [drifted({ filePath: longPath })] }),
      false
    ).join('\n');
    expect(text).toContain(longPath);
  });

  it('notes the repair on repaired sessions', () => {
    const text = formatVerifyReport(
      verifyResult({ drifted: [drifted({ repaired: true })], repaired: 1 }),
      true
    ).join('\n');
    expect(text).toContain('file_modified_at cleared');
    expect(text).toContain('Repaired: 1');
  });
});
