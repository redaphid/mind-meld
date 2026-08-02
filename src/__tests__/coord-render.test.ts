// `gh issue list` defaults to --limit 30 and says nothing when it truncates.
// The repo had 46 open issues, so the section headed "operator-authored,
// AUTHORITATIVE" printed 8 of 14 and dropped the six oldest — and #80's own
// verification cited that truncated count as proof of correctness.
//
// So: every list passes an explicit limit, and hitting the limit is LOUD.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, '../../scripts/coord/render.mjs');

function run(args: string[], stdin: unknown): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    input: JSON.stringify(stdin),
    encoding: 'utf8',
  });
}

/** Run with raw stdin, capturing output even when the exit code is nonzero. */
function runRaw(args: string[], stdin: string): { out: string; code: number } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { input: stdin, encoding: 'utf8' });
  return { out: `${r.stdout}${r.stderr}`, code: r.status ?? -1 };
}

const pr = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `pr ${number}`,
  isDraft: false,
  headRefName: 'branch',
  updatedAt: '2026-08-02T00:00:00Z',
  ...extra,
});

const issue = (number: number, labels: string[] = []) => ({
  number,
  title: `issue ${number}`,
  labels: labels.map((name) => ({ name })),
});

describe('render prs', () => {
  it('lists open PRs and marks drafts', () => {
    const out = run(['prs', '--limit', '500'], [pr(1), pr(2, { isDraft: true })]);
    expect(out).toContain('- #1 pr 1 — `branch`, updated 2026-08-02T00:00:00Z');
    expect(out).toContain('- #2 (draft) pr 2');
  });

  it('says "none" rather than printing nothing at all', () => {
    expect(run(['prs', '--limit', '500'], [])).toContain('none');
  });
});

describe('render numbers', () => {
  it('joins issue numbers for a board column', () => {
    expect(run(['numbers', '--limit', '500'], [issue(3), issue(4)]).trim()).toBe('#3, #4');
  });

  it('renders an empty column as empty, not as a stray comma', () => {
    expect(run(['numbers', '--limit', '500'], []).trim()).toBe('');
  });
});

describe('render unlabeled', () => {
  it('keeps only issues carrying no labels at all', () => {
    const out = run(['unlabeled', '--limit', '500'], [issue(5), issue(6, ['in-progress'])]);
    expect(out).toContain('- #5 issue 5');
    expect(out).not.toContain('#6');
  });
});

describe('truncation', () => {
  it('shouts when the result count reaches the limit, because the list is then INCOMPLETE', () => {
    const out = run(['unlabeled', '--limit', '2'], [issue(7), issue(8)]);
    expect(out).toContain('TRUNCATED');
    expect(out).toContain('2');
  });

  it('stays quiet when the result is comfortably under the limit', () => {
    const out = run(['unlabeled', '--limit', '500'], [issue(9)]);
    expect(out).not.toContain('TRUNCATED');
  });

  // The coordinator's question: is the banner keyed on the raw count in EVERY
  // path? It was not. A fetch that produced nothing rendered as "- none" — an
  // empty list and a failed fetch were the same output. That is the identical
  // failure class as S4 itself: absence of data presented as knowledge.
  it('does not render a failed fetch as an empty list', () => {
    const { out, code } = runRaw(['unlabeled', '--limit', '500'], '');
    expect(out).toContain('NO DATA');
    expect(out).not.toContain('- none');
    expect(code).not.toBe(0);
  });

  it('says so legibly when the input is not JSON, rather than dumping a stack trace', () => {
    const { out, code } = runRaw(['numbers', '--limit', '500'], 'not json');
    expect(out).toContain('NO DATA');
    expect(out).not.toContain('SyntaxError');
    expect(code).not.toBe(0);
  });

  it('still distinguishes a genuinely empty list from no data at all', () => {
    const { out, code } = runRaw(['unlabeled', '--limit', '500'], '[]');
    expect(out).toContain('none');
    expect(out).not.toContain('NO DATA');
    expect(code).toBe(0);
  });

  it('warns on the RAW count, not the filtered count', () => {
    // `unlabeled` filters after fetching. 30 issues of which 2 are unlabeled
    // still means the fetch was capped and unlabeled ones may be missing.
    const many = Array.from({ length: 10 }, (_, i) => issue(100 + i, i < 8 ? ['x'] : []));
    const out = run(['unlabeled', '--limit', '10'], many);
    expect(out).toContain('TRUNCATED');
  });
});
