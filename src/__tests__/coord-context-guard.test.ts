// `.claude/settings.json` is committed, so this hook runs for every contributor
// to a public repo — not just the coordinator. Ungated, any developer with a
// large transcript was told, mid-task, to run `handoff.sh --to vNEXT` for a
// coordinator they are not running. The default must therefore be silence.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../..');
const HOOK = '.claude/hooks/coordinator-context-guard.sh';

/**
 * The opt-in variable is set INSIDE the shell command rather than through
 * `execFileSync`'s `env`: on a Windows host `bash` may resolve to the WSL
 * launcher, which does not inherit the parent process environment. Setting it
 * in-line is portable and tests the same thing.
 */
function runGuard(transcriptPath: string, optIn: boolean): string {
  const script = `${optIn ? 'COORD_CONTEXT_GUARD=1 ' : ''}bash ${HOOK}`;
  return execFileSync('bash', ['-c', script], {
    cwd: REPO,
    // A path is enough; only the file's size is read.
    input: JSON.stringify({ transcript_path: transcriptPath }),
    encoding: 'utf8',
  });
}

describe('coordinator context guard', () => {
  const dir = mkdtempSync(join(REPO, 'node_modules', '.guard-'));
  const big = join(dir, 'transcript.jsonl');
  writeFileSync(big, 'x'.repeat(6_000_000));
  const rel = relative(REPO, big).split(sep).join('/');

  it('warns about context pressure once opted in', () => {
    const out = runGuard(rel, true);
    expect(out).toContain('CONTEXT PRESSURE');
    expect(out).toContain('handoff.sh');
  });

  it('says nothing at all when it has not been opted into', () => {
    // The whole point of S6: silence is the default for everyone else.
    expect(runGuard(rel, false)).toBe('');
  });

  it('is still fail-open: a missing transcript is silent, not an error', () => {
    expect(runGuard('does/not/exist.jsonl', true)).toBe('');
  });

  it('cleans up its fixture', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
