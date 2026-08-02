import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Black-box: the guard is a plain node script that any agent runtime can wire
// to a pre-tool hook, so it is tested the way a runtime calls it — spawn it,
// feed it a hook payload on stdin, read the exit code.
const here = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(here, '../../scripts/coord/hooks/gh-comment-guard.mjs');

const ROBOT = '\u{1F916}';
const MARKED = `${ROBOT} **Agent (Mira):** cycle 2 green`;

function runGuard(command: string, opts: { stdinJson?: boolean } = {}) {
  const payload =
    opts.stdinJson === false
      ? command
      : JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const r = spawnSync(process.execPath, [GUARD], { input: payload, encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

const allowed = (command: string) => runGuard(command).code === 0;

describe('gh-comment-guard: allows anything that is not a comment', () => {
  it.each([
    'pnpm run test',
    'git push -u origin feat/x',
    'gh pr view 90 --json body',
    'gh issue list --label bug',
    'gh pr checkout 77',
    'scripts/coord/heartbeat.sh "cycle complete"',
  ])('allows %s', (cmd) => {
    expect(allowed(cmd)).toBe(true);
  });

  it('allows an empty or malformed payload rather than wedging the session', () => {
    expect(runGuard('', { stdinJson: false }).code).toBe(0);
    expect(runGuard('not json at all', { stdinJson: false }).code).toBe(0);
  });

  it('ignores tools other than Bash', () => {
    const r = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'x' } }),
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
  });
});

describe('gh-comment-guard: blocks unmarked comments', () => {
  it.each([
    ['gh issue comment', `gh issue comment 79 --body "please take a look"`],
    ['gh pr comment', `gh pr comment 90 --body "pushed the fix"`],
    ['gh pr comment -b', `gh pr comment 90 -b "pushed the fix"`],
    ['gh pr comment --body=', `gh pr comment 90 --body="pushed the fix"`],
    ['gh pr review', `gh pr review 90 --request-changes --body "this is wrong"`],
    ['gh api POST comments', `gh api repos/o/r/issues/79/comments -f body="status update"`],
    [
      'gh api PATCH comment',
      `gh api --method PATCH repos/o/r/issues/comments/12 -f body='status update'`,
    ],
    ['chained after another command', `git push && gh pr comment 90 --body "done"`],
    ['chained with semicolons', `git push ; gh issue comment 79 --body "done"`],
  ])('blocks %s', (_label, cmd) => {
    const r = runGuard(cmd);
    expect(r.code).toBe(2);
  });

  it('tells the agent exactly what to prepend', () => {
    const r = runGuard(`gh pr comment 90 --body "done"`);
    expect(r.stderr).toContain('🤖 **Agent (');
    expect(r.stderr).toMatch(/marker/i);
  });

  it('does not rewrite the comment for the agent', () => {
    // Blocking beats auto-fixing: silently editing an agent's words is worse
    // than making it fix them, and a rewritten body hides the violation.
    const r = runGuard(`gh pr comment 90 --body "done"`);
    expect(r.stdout).not.toContain('done');
  });

  it('blocks an unnamed agent marker — the name is half the protocol (#79)', () => {
    expect(allowed(`gh pr comment 90 --body "${ROBOT} **Agent:** done"`)).toBe(false);
  });

  it('blocks a body whose marker is only quoted', () => {
    expect(allowed(`gh pr comment 90 --body "> ${MARKED}

ok"`)).toBe(false);
  });
});

describe('gh-comment-guard: allows properly marked comments', () => {
  it.each([
    ['agent marker', `gh pr comment 90 --body "${MARKED}"`],
    ['coordinator marker', `gh issue comment 66 --body "${ROBOT} **Coordinator v2:** cycle done"`],
    ['single quotes', `gh pr comment 90 --body '${MARKED}'`],
    ['--body= form', `gh pr comment 90 --body="${MARKED}"`],
    ['review body', `gh pr review 90 --approve --body "${MARKED}"`],
    ['gh api -f body=', `gh api repos/o/r/issues/79/comments -f body="${MARKED}"`],
    ['chained', `git push && gh pr comment 90 --body "${MARKED}"`],
  ])('allows %s', (_label, cmd) => {
    expect(allowed(cmd)).toBe(true);
  });

  it('allows a multi-line body whose first line carries the marker', () => {
    expect(allowed(`gh pr comment 90 --body "${MARKED}

More detail on the next line."`)).toBe(true);
  });
});

describe('gh-comment-guard: --body-file', () => {
  const withTmpFile = (contents: string, fn: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'marker-guard-'));
    const file = join(dir, 'body.md');
    writeFileSync(file, contents, 'utf8');
    try {
      fn(file.replace(/\\/g, '/'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reads the file and allows a marked body', () => {
    withTmpFile(MARKED, (f) => expect(allowed(`gh pr comment 90 --body-file ${f}`)).toBe(true));
  });

  it('reads the file and blocks an unmarked body', () => {
    withTmpFile('just some text', (f) =>
      expect(allowed(`gh pr comment 90 --body-file ${f}`)).toBe(false),
    );
  });

  it('fails OPEN when the file cannot be read — our bug must not wedge the session', () => {
    const r = runGuard(`gh pr comment 90 --body-file /definitely/not/here.md`);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/could not/i);
  });
});

describe('gh-comment-guard: bodies it cannot resolve', () => {
  it('resolves a heredoc body', () => {
    const cmd = `gh pr comment 90 --body "$(cat <<'EOF'\n${MARKED}\nEOF\n)"`;
    expect(allowed(cmd)).toBe(true);
  });

  it('blocks an unmarked heredoc body', () => {
    const cmd = `gh pr comment 90 --body "$(cat <<'EOF'\nstatus update\nEOF\n)"`;
    expect(allowed(cmd)).toBe(false);
  });

  it('blocks a body that comes from a shell variable, and says how to fix it', () => {
    // Fail closed: an unreadable body is exactly how unmarked comments escape.
    const r = runGuard(`gh pr comment 90 --body "$BODY"`);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/could not read the body|inline/i);
  });
});

describe('gh-comment-guard: --command mode for non-Claude runtimes', () => {
  it('accepts the command directly on argv', () => {
    const bad = spawnSync(process.execPath, [GUARD, '--command', `gh pr comment 90 --body "hi"`], {
      encoding: 'utf8',
    });
    expect(bad.status).toBe(2);
    const good = spawnSync(
      process.execPath,
      [GUARD, '--command', `gh pr comment 90 --body "${MARKED}"`],
      { encoding: 'utf8' },
    );
    expect(good.status).toBe(0);
  });
});
