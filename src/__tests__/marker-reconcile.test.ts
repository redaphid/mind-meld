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
    ['a cycle report', 'Cycle 3 green: added the reconciler. 24 tests passing, type-check clean.\n\nNext: docs.'],
    ['a green-gates report', 'All 364 tests pass, type-check clean, `pnpm run quality` OK — both ratchets held.'],
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
        c({ id: 1, body: 'Cycle 2 green: 15 tests passing, type-check clean.\n\nNext: the docs.' }),
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
