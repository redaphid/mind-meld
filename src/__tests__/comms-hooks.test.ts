/**
 * Tests for the comms-protocol enforcement hooks (.claude/hooks/*.mjs).
 *
 * The hooks are plain-node scripts that shell out to `gh` and `git`. They are
 * tested black-box: each test spawns the real script with a stubbed `gh` on
 * PATH (driven by a per-test responses.json) inside a throwaway git repo, and
 * asserts on exit code / stdout / stderr. Every hook must FAIL OPEN: any gh or
 * git failure exits 0 with a warning on stderr, never blocking the session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../.claude/hooks');

interface GhResponse {
  /** All substrings must appear in the space-joined argv for this entry to match. */
  match: string[];
  stdout?: string;
  exitCode?: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A sandbox with a fake `gh` on PATH and a real throwaway git repo. */
class HookSandbox {
  readonly dir: string;
  readonly binDir: string;
  readonly repoDir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'comms-hooks-'));
    this.binDir = join(this.dir, 'bin');
    this.repoDir = join(this.dir, 'repo');
    mkdirSync(this.binDir);
    mkdirSync(this.repoDir);
    const stub = [
      '#!/usr/bin/env node',
      "const { readFileSync, appendFileSync } = require('node:fs');",
      "const dir = process.env.GH_STUB_DIR;",
      "const args = process.argv.slice(2);",
      "appendFileSync(dir + '/calls.log', JSON.stringify(args) + '\\n');",
      "const responses = JSON.parse(readFileSync(dir + '/responses.json', 'utf8'));",
      "const joined = args.join(' ');",
      'const hit = responses.find((r) => r.match.every((m) => joined.includes(m)));',
      "if (!hit) { process.stderr.write('gh stub: no match for: ' + joined + '\\n'); process.exit(1); }",
      "if (hit.stdout) process.stdout.write(hit.stdout);",
      'process.exit(hit.exitCode ?? 0);',
    ].join('\n');
    writeFileSync(join(this.binDir, 'gh'), stub);
    chmodSync(join(this.binDir, 'gh'), 0o755);
    this.setResponses([]);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: this.repoDir });
  }

  setBranch(name: string): void {
    execFileSync('git', ['checkout', '-q', '-B', name], {
      cwd: this.repoDir,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  }

  setResponses(responses: GhResponse[]): void {
    writeFileSync(join(this.dir, 'responses.json'), JSON.stringify(responses));
    writeFileSync(join(this.dir, 'calls.log'), '');
  }

  ghCalls(): string[][] {
    const log = readFileSync(join(this.dir, 'calls.log'), 'utf8').trim();
    return log === '' ? [] : log.split('\n').map((l) => JSON.parse(l) as string[]);
  }

  run(script: string, stdinJson: unknown, extraArgs: string[] = []): Promise<RunResult> {
    return new Promise((resolvePromise, reject) => {
      const child = execFile(
        process.execPath,
        [join(HOOKS_DIR, script), ...extraArgs],
        {
          cwd: this.repoDir,
          env: { ...process.env, PATH: `${this.binDir}:${process.env.PATH}`, GH_STUB_DIR: this.dir },
          timeout: 15_000,
        },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') return reject(error);
          resolvePromise({ code: error ? (error.code as number) : 0, stdout, stderr });
        },
      );
      child.stdin?.end(stdinJson === undefined ? '' : JSON.stringify(stdinJson));
    });
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

let sandbox: HookSandbox;
beforeEach(() => {
  sandbox = new HookSandbox();
});
afterEach(() => {
  sandbox.cleanup();
});

describe('stop-pr-progress hook', () => {
  const SCRIPT = 'stop-pr-progress.mjs';
  const prView = (comments: string[], commits: string[]) =>
    JSON.stringify({
      number: 42,
      comments: comments.map((createdAt) => ({ createdAt })),
      commits: commits.map((committedDate) => ({ committedDate })),
    });

  it('exists as a hook script', () => {
    expect(existsSync(join(HOOKS_DIR, SCRIPT))).toBe(true);
  });

  it('allows stop immediately when stop_hook_active is set (loop guard)', async () => {
    sandbox.setBranch('feat/thing-42');
    const result = await sandbox.run(SCRIPT, { stop_hook_active: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(sandbox.ghCalls()).toEqual([]);
  });

  it('does nothing on the main branch', async () => {
    const result = await sandbox.run(SCRIPT, {});
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(sandbox.ghCalls()).toEqual([]);
  });

  it('allows stop when the branch has no open PR', async () => {
    sandbox.setBranch('feat/thing-42');
    sandbox.setResponses([{ match: ['pr', 'view'], exitCode: 1, stdout: '' }]);
    const result = await sandbox.run(SCRIPT, {});
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('blocks (decision:block) when the PR has no comment newer than the last commit', async () => {
    sandbox.setBranch('feat/thing-42');
    sandbox.setResponses([
      {
        match: ['pr', 'view'],
        stdout: prView(['2026-08-01T10:00:00Z'], ['2026-08-01T12:00:00Z']),
      },
    ]);
    const result = await sandbox.run(SCRIPT, {});
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { decision: string; reason: string };
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('#42');
    expect(parsed.reason).toContain('progress comment');
  });

  it('allows stop when a comment is newer than the last commit', async () => {
    sandbox.setBranch('feat/thing-42');
    sandbox.setResponses([
      {
        match: ['pr', 'view'],
        stdout: prView(['2026-08-01T13:00:00Z'], ['2026-08-01T12:00:00Z']),
      },
    ]);
    const result = await sandbox.run(SCRIPT, {});
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('blocks when the PR has commits but no comments at all', async () => {
    sandbox.setBranch('feat/thing-42');
    sandbox.setResponses([{ match: ['pr', 'view'], stdout: prView([], ['2026-08-01T12:00:00Z']) }]);
    const result = await sandbox.run(SCRIPT, {});
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { decision: string }).decision).toBe('block');
  });

  it('fails open with a stderr warning when gh output is garbage', async () => {
    sandbox.setBranch('feat/thing-42');
    sandbox.setResponses([{ match: ['pr', 'view'], stdout: 'not json at all' }]);
    const result = await sandbox.run(SCRIPT, {});
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('warning');
  });
});

describe('post-pr-create hook', () => {
  const SCRIPT = 'post-pr-create.mjs';
  const stdin = (command: string) => ({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout: 'https://github.com/redaphid/mind-meld/pull/77' },
  });
  const issueLabels = (labels: string[]) => JSON.stringify({ labels: labels.map((name) => ({ name })) });

  it('exists as a hook script', () => {
    expect(existsSync(join(HOOKS_DIR, SCRIPT))).toBe(true);
  });

  it('ignores Bash commands that are not gh pr create', async () => {
    const result = await sandbox.run(SCRIPT, stdin('git push origin main'));
    expect(result.code).toBe(0);
    expect(sandbox.ghCalls()).toEqual([]);
  });

  it('stays silent when the linked issue is already in-review', async () => {
    sandbox.setBranch('feat/thing-42');
    sandbox.setResponses([{ match: ['issue', 'view', '42'], stdout: issueLabels(['in-review', 'user-ask']) }]);
    const result = await sandbox.run(SCRIPT, stdin('gh pr create --draft --title x'));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('warns Claude (exit 2) when the linked issue was not flipped to in-review', async () => {
    sandbox.setBranch('feat/thing-42');
    sandbox.setResponses([{ match: ['issue', 'view', '42'], stdout: issueLabels(['in-progress']) }]);
    const result = await sandbox.run(SCRIPT, stdin('gh pr create --draft --title x'));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('#42');
    expect(result.stderr).toContain('in-review');
  });

  it('finds the issue number in the command text when the branch has none', async () => {
    sandbox.setBranch('some-branch');
    sandbox.setResponses([{ match: ['issue', 'view', '75'], stdout: issueLabels([]) }]);
    const result = await sandbox.run(SCRIPT, stdin('gh pr create --title "Fix thing" --body "Closes #75"'));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('#75');
  });

  it('does nothing when no issue number can be determined', async () => {
    sandbox.setBranch('some-branch');
    const result = await sandbox.run(SCRIPT, stdin('gh pr create --title "Fix thing"'));
    expect(result.code).toBe(0);
    expect(sandbox.ghCalls()).toEqual([]);
  });

  it('fails open when gh fails', async () => {
    sandbox.setBranch('feat/thing-42');
    sandbox.setResponses([{ match: ['issue', 'view'], exitCode: 1 }]);
    const result = await sandbox.run(SCRIPT, stdin('gh pr create --draft'));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('warning');
  });
});

describe('reconcile-labels script', () => {
  const SCRIPT = 'reconcile-labels.mjs';
  const HOUR = 60 * 60 * 1000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  const issue = (number: number, labels: string[], msAgo = 0) => ({
    number,
    title: `Issue ${number}`,
    labels: labels.map((name) => ({ name })),
    updatedAt: iso(msAgo),
  });
  const listResponses = (issues: unknown[], prs: unknown[]): GhResponse[] => [
    { match: ['issue', 'list'], stdout: JSON.stringify(issues) },
    { match: ['pr', 'list'], stdout: JSON.stringify(prs) },
  ];
  const comments = (n: number, entries: Array<{ association: string; body: string; id?: number }>): GhResponse => ({
    match: ['issue', 'view', String(n), '--json', 'comments'],
    stdout: JSON.stringify({
      comments: entries.map((e, i) => ({ authorAssociation: e.association, body: e.body, id: e.id ?? i + 1 })),
    }),
  });
  const editCalls = () => sandbox.ghCalls().filter((args) => args[0] === 'issue' && args[1] === 'edit');

  it('exists as a script', () => {
    expect(existsSync(join(HOOKS_DIR, SCRIPT))).toBe(true);
  });

  it('reports no drift and exits 0 when labels match reality', async () => {
    sandbox.setResponses(listResponses([issue(10, ['in-progress'], HOUR)], [{ number: 90, headRefName: 'feat/x-10', body: '', isDraft: true, updatedAt: iso(0) }]));
    const result = await sandbox.run(SCRIPT, undefined);
    expect(result.code).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('no drift');
    expect(editCalls()).toEqual([]);
  });

  it('flags needs-human when the last comment is an unmarked OWNER response (dry-run, exit 1, no edits)', async () => {
    sandbox.setResponses([
      ...listResponses([issue(11, ['needs-human'])], []),
      comments(11, [
        { association: 'OWNER', body: '🤖 **Coordinator:** plan posted, needs your call' },
        { association: 'OWNER', body: 'yes, go ahead', id: 555 },
      ]),
    ]);
    const result = await sandbox.run(SCRIPT, undefined);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('#11');
    expect(result.stdout).toContain('needs-human');
    expect(editCalls()).toEqual([]);
  });

  it('does not flag needs-human when the last comment is agent-marked', async () => {
    sandbox.setResponses([
      ...listResponses([issue(12, ['needs-human'])], []),
      comments(12, [{ association: 'OWNER', body: '🤖 **Coordinator:** waiting on your approval' }]),
    ]);
    const result = await sandbox.run(SCRIPT, undefined);
    expect(result.code).toBe(0);
  });

  it('flags stale in-progress with no open PR, but not fresh ones', async () => {
    sandbox.setResponses(listResponses([issue(13, ['in-progress'], 9 * HOUR), issue(14, ['in-progress'], HOUR / 2)], []));
    const result = await sandbox.run(SCRIPT, undefined);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('#13');
    expect(result.stdout).not.toContain('#14');
  });

  it('flags in-review with no open PR, and in-progress issues whose PR is ready for review', async () => {
    sandbox.setResponses(
      listResponses(
        [issue(15, ['in-review']), issue(16, ['in-progress'], HOUR / 2)],
        [{ number: 91, headRefName: 'feat/y-16', body: 'Implements #16', isDraft: false, updatedAt: iso(0) }],
      ),
    );
    const result = await sandbox.run(SCRIPT, undefined);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('#15');
    expect(result.stdout).toContain('#16');
  });

  it('applies fixes with --fix and exits 0', async () => {
    sandbox.setResponses([
      ...listResponses([issue(17, ['needs-human'])], []),
      comments(17, [{ association: 'OWNER', body: 'approved', id: 777 }]),
      { match: ['issue', 'edit'], stdout: '' },
    ]);
    const result = await sandbox.run(SCRIPT, undefined, ['--fix']);
    expect(result.code).toBe(0);
    const edits = editCalls();
    expect(edits.length).toBe(1);
    expect(edits[0]).toContain('17');
    expect(edits[0].join(' ')).toContain('--remove-label needs-human');
  });

  it('writes high-water marks to .claude/coordinator-state.json', async () => {
    sandbox.setResponses([
      ...listResponses([issue(18, ['needs-human'])], []),
      comments(18, [{ association: 'OWNER', body: 'go', id: 999 }]),
    ]);
    await sandbox.run(SCRIPT, undefined);
    const statePath = join(sandbox.repoDir, '.claude/coordinator-state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      lastReconcileAt: string;
      issues: Record<string, { lastSeenCommentId: number }>;
    };
    expect(state.lastReconcileAt).toBeTruthy();
    expect(state.issues['18'].lastSeenCommentId).toBe(999);
  });

  it('fails open (exit 0, warning) when gh is unavailable', async () => {
    sandbox.setResponses([{ match: ['issue', 'list'], exitCode: 1 }]);
    const result = await sandbox.run(SCRIPT, undefined);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('warning');
  });
});
