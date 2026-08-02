import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The CLI exists so bash, CI, and non-JS runtimes get exactly the same answers
// as the node callers — one grammar, not two implementations that drift.
const here = dirname(fileURLToPath(import.meta.url));
const MARKER = resolve(here, '../../scripts/coord/marker.mjs');
const COMMENT = resolve(here, '../../scripts/coord/comment.mjs');

const ROBOT = '\u{1F916}';
const run = (script: string, args: string[], input = '', env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

describe('marker.mjs CLI', () => {
  it('classify emits JSON on stdout', () => {
    const r = run(MARKER, ['classify'], `${ROBOT} **Agent (Mira):** hi`);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ actor: 'agent', name: 'Mira', valid: true });
  });

  it('check exits 0 for a valid marker and 1 without one', () => {
    expect(run(MARKER, ['check'], `${ROBOT} **Agent (Mira):** hi`).status).toBe(0);
    const bad = run(MARKER, ['check'], 'no marker here');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/marker/i);
  });

  it('marker prints a marker its own classifier accepts', () => {
    const out = run(MARKER, ['marker', '--agent', 'Mira']).stdout.trim();
    expect(out).toBe(`${ROBOT} **Agent (Mira):**`);
    expect(run(MARKER, ['check'], `${out} hi`).status).toBe(0);
  });

  it('unanswered reads GitHub comment JSON on stdin', () => {
    const comments = [
      {
        id: 1,
        user: { login: 'owner' },
        author_association: 'OWNER',
        created_at: '2026-08-01T01:00:00Z',
        html_url: 'https://example.invalid/1',
        body: 'is this done?',
      },
      {
        id: 2,
        user: { login: 'owner' },
        author_association: 'OWNER',
        created_at: '2026-08-01T02:00:00Z',
        html_url: 'https://example.invalid/2',
        body: `${ROBOT} **Agent (Mira):** pushed cycle 3`,
      },
    ];
    const r = run(MARKER, ['unanswered', '--owner', 'owner'], JSON.stringify(comments));
    expect(r.status).toBe(0);
    // The agent comment must NOT have buried the operator's question.
    expect(r.stdout).toContain('is this done?');
  });

  it('survives garbage on stdin without failing the caller', () => {
    const r = run(MARKER, ['unanswered', '--owner', 'owner'], 'not json');
    expect(r.status).toBe(0);
  });
});

describe('comment.mjs — the sanctioned way to post', () => {
  it('prepends the marker so an agent cannot forget it', () => {
    const r = run(COMMENT, ['--issue', '79', '--body', 'cycle 2 green', '--dry-run'], '', {
      COORD_AGENT_NAME: 'Mira',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${ROBOT} **Agent (Mira):** cycle 2 green`);
  });

  it('does not double-prepend a marker the body already has', () => {
    const body = `${ROBOT} **Agent (Mira):** already marked`;
    const r = run(COMMENT, ['--issue', '79', '--body', body, '--dry-run'], '', {
      COORD_AGENT_NAME: 'Mira',
    });
    expect(r.stdout.match(/Agent \(Mira\)/g)).toHaveLength(1);
  });

  it('refuses to post without a name — the name is half the protocol (#79)', () => {
    const r = run(COMMENT, ['--issue', '79', '--body', 'hi', '--dry-run'], '', {
      COORD_AGENT_NAME: '',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/name/i);
  });

  it('posts as the coordinator when a generation is given', () => {
    const r = run(COMMENT, ['--issue', '66', '--coordinator', 'v2', '--body', 'x', '--dry-run']);
    expect(r.stdout).toContain(`${ROBOT} **Coordinator v2:** x`);
  });

  it('emits a body that the guard would allow', () => {
    const GUARD = resolve(here, '../../scripts/coord/hooks/gh-comment-guard.mjs');
    const body = run(COMMENT, ['--issue', '79', '--body', 'hi', '--dry-run'], '', {
      COORD_AGENT_NAME: 'Mira',
    }).stdout.trim();
    const r = spawnSync(process.execPath, [GUARD, '--command', `gh issue comment 79 --body '${body}'`], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
  });
});
