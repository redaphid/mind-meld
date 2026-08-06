// Mechanical guard for the .dockerignore / Dockerfile CMD split.
//
// Five of six Dockerfiles here are single-stage `COPY . .`, so what ships is
// "the repo minus .dockerignore". Two of them then run a pnpm script that
// lives in scripts/ — and .dockerignore excluded that whole directory under
// the comment "Operator-side helper scripts, not container entrypoints." Both
// containers had never once succeeded: every start died on
// ERR_MODULE_NOT_FOUND and, because the CMD chained `sleep` behind `&&`, the
// failure skipped its own backoff and respawned ~3.5 times a second. Two cores
// burned continuously on a box whose GPU work was competing for the same
// memory bandwidth, and centroids were silently never computed.
//
// Nothing failed loudly, because nothing checked that the file a CMD executes
// survives the build context. That is a list that must match another list
// (CLAUDE.md: "Shared definitions over restated ones"), so it gets enforced
// the way quality/service-worker-shell.json enforces the SHELL list.
//
// Two checks per `pnpm <script>` found in a Dockerfile CMD:
//
//   1. DECLARED — the script exists in package.json, and the file it runs
//      exists on disk.
//   2. SHIPPED  — that file is not excluded by .dockerignore.
//
// SCOPE, stated honestly: the matcher below implements Docker's "last matching
// pattern wins" over literal paths, `*` and `**`, which covers every pattern
// .dockerignore currently uses. It is not a complete reimplementation of
// Go's filepath.Match — it is a guard against a directory-level exclusion
// swallowing an entrypoint, which is the failure that actually happened.
//
// Failures name PATHS ONLY, never file contents: this repo's CI logs are
// public (issue #64), the same rule the other quality tests follow.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

const read = (relative: string) => readFileSync(join(repoRoot, relative), 'utf8');

// A .dockerignore line becomes a regex anchored at the context root. `**`
// spans path separators, `*` does not.
const toMatcher = (pattern: string) => {
  const body = pattern
    .split('/')
    .map((segment) =>
      segment === '**'
        ? '.*'
        : segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
    )
    .join('/');
  // Excluding `scripts` excludes everything beneath it, so a directory
  // pattern also matches its descendants.
  return new RegExp(`^${body}(/.*)?$`);
};

const dockerignoreRules = () =>
  read('.dockerignore')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => ({
      negated: line.startsWith('!'),
      matches: toMatcher(line.replace(/^!/, '').replace(/^\.\//, '').replace(/\/$/, '')),
    }));

// Docker evaluates every pattern in order; the last one that matches decides.
const isExcluded = (path: string, rules: ReturnType<typeof dockerignoreRules>) =>
  rules.reduce((excluded, rule) => (rule.matches.test(path) ? !rule.negated : excluded), false);

// `pnpm mark:warmups`, `pnpm run compute:centroids` — but not `pnpm install`,
// which resolves no script of ours.
const scriptsInvokedBy = (dockerfile: string) =>
  [...dockerfile.matchAll(/\bpnpm\s+(?:run\s+)?([\w:.-]+)/g)]
    .map((match) => match[1])
    .filter((name) => name !== 'install');

// "tsx scripts/mark-warmups.ts" -> "scripts/mark-warmups.ts"
const fileRunBy = (command: string) =>
  command.split(/\s+/).find((token) => /\.(ts|mjs|cjs|js)$/.test(token));

const dockerfiles = readdirSync(repoRoot).filter((name) => name.startsWith('Dockerfile'));

const packageScripts: Record<string, string> = JSON.parse(read('package.json')).scripts ?? {};

const entrypoints = dockerfiles.flatMap((dockerfile) =>
  scriptsInvokedBy(read(dockerfile))
    .filter((name) => name in packageScripts)
    .map((name) => ({ dockerfile, name, file: fileRunBy(packageScripts[name]) }))
);

describe('Dockerfile entrypoints survive .dockerignore', () => {
  it('finds the pnpm scripts that Dockerfiles run', () => {
    // A parser that silently matches nothing would make every check below
    // pass vacuously.
    expect(entrypoints.length).toBeGreaterThan(0);
  });

  it.each(entrypoints)('$dockerfile runs $name, which exists', ({ name, file }) => {
    expect(file, `package.json script "${name}" runs no resolvable file`).toBeDefined();
    expect(existsSync(join(repoRoot, file!)), `${file} is missing from the repo`).toBe(true);
  });

  it.each(entrypoints)('$dockerfile ships the file behind $name', ({ name, file }) => {
    const excluded = isExcluded(file!, dockerignoreRules());
    expect(
      excluded,
      `.dockerignore excludes ${file}, so "pnpm ${name}" dies on ERR_MODULE_NOT_FOUND in the image. ` +
        `Add an explicit negation: !${file}`
    ).toBe(false);
  });
});
