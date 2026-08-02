import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(resolve(here, '../../scripts/coord/marker-reconcile.mjs')).href;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rec: any;
beforeAll(async () => {
  rec = await import(/* @vite-ignore */ MODULE);
});

const ROBOT = '\u{1F916}';

describe('machineAuthorship: signals that a body was written by a machine', () => {
  it.each([
    ['a Claude Code footer', 'looks fine\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'],
    [
      'a cycle report',
      'Cycle 3 green: added the reconciler, with the signal table split into conclusive and stylistic tiers.\n\n' +
        '24 tests passing, type-check clean.\n\nNext: the docs, then a live dry run over the last fifty threads.',
    ],
    [
      'a green-gates report',
      'Rebased onto main and re-ran everything after the parser change.\n\n' +
        'All 364 tests pass, type-check clean, `pnpm run quality` OK — both ratchets held and the baselines are untouched.\n\n' +
        'Next: the verification transcript.',
    ],
    ['a review verdict', '## Review\n\n**Verdict: request changes**\n\n### S1 — the parser drops data\n\nSee line 40.'],
    ['a structured status report', '## Summary\n\n- item one\n- item two\n\n## Testing\n\n```\npnpm test\n```\n\n## Next steps\n\nmore'],
  ])('flags %s', (_label, body) => {
    const r = rec.machineAuthorship(body);
    expect(r.isMachine).toBe(true);
    expect(r.signals.length).toBeGreaterThan(0);
  });

  it.each([
    ['a short instruction', "Don't put it in `.claude/`. It needs to be in some provider agnostic place"],
    ['a terse question', 'is this done?'],
    ['a one-line correction', 'no, use the other one'],
    ['a short note with a code span', 'try `pnpm run sync` first'],
    ['an empty body', ''],
    ['a short link drop', 'see https://example.invalid/thing'],
  ])('does not flag %s', (_label, body) => {
    expect(rec.machineAuthorship(body).isMachine).toBe(false);
  });

  it('never flags a body that already carries a marker', () => {
    const body = `${ROBOT} **Agent (Mira):** Cycle 3 green, 24 tests passing, type-check clean.`;
    expect(rec.machineAuthorship(body).isMachine).toBe(false);
  });

  it('reports why it decided, so a human can audit a --fix before running it', () => {
    const r = rec.machineAuthorship('Cycle 3 green: 24 tests passing, type-check clean.\n\nNext: docs.');
    expect(r.signals.join(' ')).toMatch(/cycle|test|next/i);
    expect(typeof r.score).toBe('number');
  });
});

describe('machineAuthorship: it must never put words in the operator’s mouth', () => {
  // Stamping one of the operator's own comments as machine-authored is worse
  // than the bug this tool fixes: it misattributes his words and then teaches
  // every downstream tool to ignore them. So `--fix` needs evidence that a
  // MACHINE wrote it, not evidence that the writing is long and tidy.

  it('does not read quoted agent text as the operator being a machine', () => {
    // The operator pasting an agent's report back at it, to complain about it,
    // is the most likely way this ever goes wrong — and it scored 10/3 before.
    const body =
      '> Cycle 3 green: 24 tests passing, type-check clean.\n> Next: the docs.\n\nno. stop reporting and answer my question.';
    const r = rec.machineAuthorship(body);
    expect(r.isMachine).toBe(false);
    expect(r.conclusive).toBe(false);
  });

  it('does not read a fenced paste as the operator being a machine', () => {
    const body =
      'this is what I keep getting:\n\n```\nCycle 3 green: 24 tests passing, type-check clean.\n```\n\nwhy?';
    expect(rec.machineAuthorship(body).conclusive).toBe(false);
  });

  it('does not read the protocol quoted in backticks as machine evidence', () => {
    const body =
      'stop ending every comment with `Next:` and `type-check clean` — I do not care about the gates, I care about the answer';
    expect(rec.machineAuthorship(body).conclusive).toBe(false);
  });

  it('never marks a long, tidy operator comment as safe to fix', () => {
    // Structure alone is not evidence. The operator writes long comments with
    // headings; that must never be enough on its own.
    const body =
      '## What I actually want\n\n' +
      'I keep coming back to this and I think the shape is wrong. '.repeat(8) +
      '\n\nDo it the other way.\n\nAnd check the other thing too.\n\nThen tell me.';
    expect(rec.machineAuthorship(body).conclusive).toBe(false);
  });

  it('requires a machine-specific signal before a body is auto-fixable', () => {
    const stylistic = rec.machineAuthorship(
      '## Summary\n\n- a\n- b\n\n## Detail\n\n```\nx\n```\n\n' + 'padding. '.repeat(60),
    );
    expect(stylistic.isMachine).toBe(true); // still reported
    expect(stylistic.conclusive).toBe(false); // but never auto-stamped

    const conclusive = rec.machineAuthorship(
      'Cycle 3 green: the reconciler now splits its signal table into conclusive and stylistic tiers, ' +
        'so structure alone can never trigger an edit.\n\n24 tests passing, type-check clean.\n\n' +
        'Next: the docs, then a live dry run over the last fifty threads.',
    );
    expect(conclusive.conclusive).toBe(true);
  });

  it.each([
    ['verdict: this is not what I asked for'],
    ['why do 3 tests pass locally but not in CI?'],
    ['is type-check clean?'],
    ['make sure 24 tests passing before you merge'],
    ['next: answer the question I actually asked'],
    ['ready for review? it looks half done'],
    ['## why\n\nbecause I said so'],
    ['cycle 3 green? it is not green on my machine'],
  ])('does not even REPORT a realistic operator one-liner: %s', (body) => {
    // Reported-but-not-fixed is still wrong: anything reading `isMachine` sees
    // the operator classified as a machine. A single keyword in one short line
    // is a question about a report, never a report.
    const r = rec.machineAuthorship(body);
    expect(r.isMachine).toBe(false);
    expect(r.conclusive).toBe(false);
  });

  it('requires more than one weak singleton signal to report', () => {
    // One weight-3 phrase alone used to clear the threshold on its own.
    const single = rec.machineAuthorship(
      'The verdict here depends on what you meant by the second requirement, which I read ' +
        'differently from you, and I would rather settle that before either of us writes code. ' +
        'Say which reading you intended and I will follow it.',
    );
    expect(single.conclusive).toBe(false);
  });

  it('treats a generated footer as machine evidence regardless of length', () => {
    // A footer is emitted by tooling, not a phrase a person types, so length
    // adds nothing — unlike the gate phrases, which the operator can use in a
    // four-word question.
    const r = rec.machineAuthorship('done\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)');
    expect(r.conclusive).toBe(true);
  });

  it.each([
    ['a terse question using gate words', 'is type-check clean?'],
    ['a terse instruction', 'make sure 349 tests passing before you merge'],
    ['a one-line verdict demand', 'verdict: just fix it'],
  ])('never auto-fixes %s — a machine report is never four words', (_label, body) => {
    expect(rec.machineAuthorship(body).conclusive).toBe(false);
  });

  it.each([
    [
      'a Claude Code footer',
      'Opened the PR against main with the parser boundary fix and a regression test.\n\n' +
        'The branch is rebased and the checks came back green.\n\n' +
        '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ],
    [
      'a cycle report',
      'Cycle 3 green: added the reconciler, with its signal table split into conclusive and stylistic tiers ' +
        'so that structure alone can never trigger an edit.\n\n24 tests passing, type-check clean.\n\n' +
        'Next: wiring the docs and running a live dry run.',
    ],
    [
      'a review verdict',
      '## Review\n\n**Verdict: request changes**\n\n### S1 — the parser drops data\n\n' +
        'The boundary at line 40 discards the tail of every multi-byte record, silently, ' +
        'so a session ending mid-character loses its final message with no error anywhere.',
    ],
  ])('still finds %s conclusive', (_label, body) => {
    expect(rec.machineAuthorship(body).conclusive).toBe(true);
  });
});

describe('findViolations', () => {
  const owner = 'redaphid';
  const c = (over: Record<string, unknown>) => ({
    id: 1,
    user: { login: owner },
    author_association: 'OWNER',
    created_at: '2026-08-01T00:00:00Z',
    html_url: 'https://example.invalid/1',
    body: 'x',
    ...over,
  });

  it('finds unmarked machine comments', () => {
    const found = rec.findViolations(
      [
        c({
          id: 1,
          body:
            'Cycle 2 green: the guard now intercepts every gh comment path, including the api ones and\n' +
            'the review bodies, and resolves heredocs.\n\n' +
            '15 tests passing, type-check clean.\n\nNext: the reconciler, then the docs.',
        }),
        c({ id: 2, body: 'sounds good' }),
      ],
      owner,
    );
    expect(found.map((v: { id: number }) => v.id)).toEqual([1]);
  });

  it('ignores correctly marked comments', () => {
    const found = rec.findViolations(
      [c({ id: 3, body: `${ROBOT} **Agent (Mira):** Cycle 2 green, 15 tests passing.` })],
      owner,
    );
    expect(found).toEqual([]);
  });

  it('ignores comments from anyone but the owner — only we post unmarked by mistake', () => {
    const found = rec.findViolations(
      [
        c({
          id: 4,
          user: { login: 'someone-else' },
          author_association: 'NONE',
          body: 'Cycle 2 green: 15 tests passing, type-check clean.\n\nNext: docs.',
        }),
      ],
      owner,
    );
    expect(found).toEqual([]);
  });
});

describe('repairedBody', () => {
  it('prepends a marker without touching the original words', () => {
    const original = 'Cycle 2 green: 15 tests passing.\n\nNext: the docs.';
    const fixed = rec.repairedBody(original);
    expect(fixed).toContain(original);
    expect(fixed.indexOf(original)).toBeGreaterThan(0);
  });

  it('produces a body the classifier accepts as a valid agent comment', async () => {
    const marker = await import(
      /* @vite-ignore */ pathToFileURL(resolve(here, '../../scripts/coord/marker.mjs')).href
    );
    const c = marker.classifyComment(rec.repairedBody('Cycle 2 green: 15 tests passing.'));
    expect(c.isMachine).toBe(true);
    expect(c.valid).toBe(true);
    expect(c.actor).toBe('agent');
  });

  it('says the marker was added retroactively, rather than pretending', () => {
    expect(rec.repairedBody('Cycle 2 green.')).toMatch(/retroactiv/i);
  });

  it('never claims to be the coordinator — that would bury an operator message', async () => {
    const marker = await import(
      /* @vite-ignore */ pathToFileURL(resolve(here, '../../scripts/coord/marker.mjs')).href
    );
    expect(marker.classifyComment(rec.repairedBody('Cycle 2 green.')).isCoordinatorReply).toBe(false);
  });
});
