// A workflow that does not parse is a workflow that does not run — and GitHub
// tells you so only by naming the workflow after its own file path in an API
// nobody reads. The coordinator deadman shipped to `main` as invalid YAML,
// went red on every push, and never executed once while appearing installed.
//
// `actionlint` in CI is the real guard (see .github/workflows/quality.yml).
// This is the fast local one, and it also catches the specific thing that broke
// the deadman: a heredoc inside a `run:` block scalar whose terminator no
// longer sits at column 0 after YAML strips the block indentation.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, sep } from 'node:path';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../..');
const WORKFLOWS = resolve(REPO, '.github/workflows');
const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('GitHub workflows', () => {
  it('finds workflows to check at all', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s is valid YAML with a name and a trigger', (file) => {
    const doc = parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as Record<string, unknown>;
    expect(doc).toBeTypeOf('object');
    // A workflow GitHub could not parse reports its `name` as its file path.
    expect(doc.name).toBeTypeOf('string');
    expect(doc.name).not.toContain('/');
    // `on:` is the YAML 1.1 boolean `true` once parsed — either key is fine,
    // absent is not.
    expect(doc.on ?? (doc as Record<string, unknown>)['true']).toBeDefined();
    expect(doc.jobs).toBeTypeOf('object');
  });

  it.each(files)('%s has shell-parseable `run:` blocks', (file) => {
    const doc = parse(readFileSync(join(WORKFLOWS, file), 'utf8')) as any;
    const runs: string[] = [];
    for (const job of Object.values<any>(doc.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        if (typeof step?.run === 'string') runs.push(step.run);
      }
    }
    // Written inside the repo and invoked by RELATIVE path: on Windows the
    // shell is git-bash, which cannot resolve a native `C:\…` argument.
    const dir = mkdtempSync(join(REPO, 'node_modules', '.wf-'));
    const rel = (p: string) => relative(REPO, p).split(sep).join('/');
    try {
      runs.forEach((script, i) => {
        const path = join(dir, `run-${i}.sh`);
        writeFileSync(path, script, 'utf8');
        // `bash -n` is what catches an unterminated heredoc: if the terminator
        // is no longer at column 0 after YAML strips the block indentation, the
        // heredoc swallows the rest of the script and bash says so.
        expect(() =>
          execFileSync('bash', ['-n', rel(path)], { cwd: REPO, stdio: 'pipe' })
        ).not.toThrow();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
