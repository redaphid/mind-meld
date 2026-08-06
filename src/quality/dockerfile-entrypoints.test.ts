// Mechanical guard for the .dockerignore / Dockerfile entrypoint split.
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
// Two checks per entrypoint file named by a CMD or ENTRYPOINT directive:
//
//   1. DECLARED — the file exists on disk (and, when reached through a pnpm
//      script, that script exists in package.json).
//   2. SHIPPED  — the file is not excluded by .dockerignore.
//
// Entrypoints are found two ways, because this repo uses both forms:
// `pnpm mark:warmups` resolved through package.json, and a direct
// `["npx", "tsx", "src/mcp/http-server.ts"]`. Only CMD/ENTRYPOINT lines are
// scanned — a `RUN pnpm install` is a build step, not an entrypoint.
//
// SCOPE, stated honestly: the matcher below implements Docker's
// "last matching pattern wins" over literal paths, `*`, `?` and `**`. It is
// not a complete reimplementation of Go's filepath.Match — it is a guard
// against an exclusion swallowing an entrypoint, which is the failure that
// actually happened. It does NOT follow imports, so a script that grows a
// dependency on an excluded sibling still fails only at runtime.
//
// Failures name PATHS ONLY, never file contents: this repo's CI logs are
// public (issue #64), the same rule the other quality tests follow.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

const read = (relative: string) => readFileSync(join(repoRoot, relative), 'utf8');

// A .dockerignore line becomes a regex anchored at the context root.
// `**/` spans zero or more directories — `foo/**/bar.ts` must still match
// `foo/bar.ts`, which is why `**` cannot be translated as its own segment.
const WILDCARDS: Record<string, string> = {
  '**/': '(?:.*/)?',
  '**': '.*',
  '*': '[^/]*',
  '?': '[^/]',
};

const toMatcher = (pattern: string) => {
  // One pass, longest wildcard first. Translating in separate passes lets an
  // earlier replacement's output be rewritten by a later one.
  const body = pattern.replace(
    /\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g,
    (token) => WILDCARDS[token] ?? `\\${token}`
  );
  // Excluding `scripts` excludes everything beneath it, so a directory
  // pattern also matches its descendants.
  return new RegExp(`^${body}(/.*)?$`);
};

const dockerignoreRules = read('.dockerignore')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
  .map((line) => ({
    negated: line.startsWith('!'),
    matches: toMatcher(line.replace(/^!/, '').replace(/^\.\//, '').replace(/\/$/, '')),
  }));

// Docker evaluates every pattern in order; the last one that matches decides.
const isExcluded = (path: string) =>
  dockerignoreRules.reduce(
    (excluded, rule) => (rule.matches.test(path) ? !rule.negated : excluded),
    false
  );

const packageScripts: Record<string, string> = JSON.parse(read('package.json')).scripts ?? {};

// Backslash continuations first, so a multi-line CMD is one directive.
const entrypointDirectives = (dockerfile: string) =>
  dockerfile
    .replace(/\\\r?\n\s*/g, ' ')
    .split('\n')
    .filter((line) => /^\s*(CMD|ENTRYPOINT)\b/.test(line));

// Works for both `CMD ["npx", "tsx", "x.ts"]` and shell-form `CMD pnpm foo`.
const tokensOf = (directive: string) =>
  directive
    .replace(/[[\],"']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

const isSourceFile = (token: string) => /\.(ts|mjs|cjs|js)$/.test(token);

// "tsx scripts/mark-warmups.ts" -> "scripts/mark-warmups.ts"
const fileRunBy = (command: string) => command.split(/\s+/).find(isSourceFile);

const entrypointsIn = (dockerfile: string) =>
  entrypointDirectives(read(dockerfile)).flatMap((directive) => {
    const tokens = tokensOf(directive);

    const direct = tokens.filter(isSourceFile).map((file) => ({ via: file, file }));

    const viaPnpm = tokens.flatMap((token, index) => {
      if (token !== 'pnpm') return [];
      const name = tokens[index + 1] === 'run' ? tokens[index + 2] : tokens[index + 1];
      if (!name || !(name in packageScripts)) return [];
      const file = fileRunBy(packageScripts[name]);
      if (!file) return [];
      return [{ via: `pnpm ${name}`, file }];
    });

    return [...direct, ...viaPnpm].map((entry) => ({ dockerfile, ...entry }));
  });

const dockerfiles = readdirSync(repoRoot).filter((name) => name.startsWith('Dockerfile'));

const entrypoints = dockerfiles.flatMap(entrypointsIn);

// Every pnpm script a CMD invokes must be declared, even if it runs no file of
// ours — an undeclared name means the CMD is already broken.
const undeclaredScripts = dockerfiles.flatMap((dockerfile) =>
  entrypointDirectives(read(dockerfile)).flatMap((directive) => {
    const tokens = tokensOf(directive);
    return tokens.flatMap((token, index) => {
      if (token !== 'pnpm') return [];
      const name = tokens[index + 1] === 'run' ? tokens[index + 2] : tokens[index + 1];
      return name && !(name in packageScripts) ? [{ dockerfile, name }] : [];
    });
  })
);

describe('Dockerfile entrypoints survive .dockerignore', () => {
  it('finds the entrypoint files that Dockerfiles run', () => {
    // A parser that silently matches nothing would make every check below
    // pass vacuously. Both scripts/ entrypoints plus the two npx CMDs.
    expect(entrypoints.map((e) => e.file).sort()).toEqual([
      'scripts/compute-centroids.ts',
      'scripts/mark-warmups.ts',
      'src/mcp/http-server.ts',
      'src/ui/server.ts',
    ]);
  });

  it('resolves every pnpm script a CMD invokes', () => {
    expect(undeclaredScripts).toEqual([]);
  });

  it.each(entrypoints)('$dockerfile runs $via, which exists', ({ file }) => {
    expect(existsSync(join(repoRoot, file)), `${file} is missing from the repo`).toBe(true);
  });

  it.each(entrypoints)('$dockerfile ships the file behind $via', ({ via, file }) => {
    expect(
      isExcluded(file),
      `.dockerignore excludes ${file}, so "${via}" dies on ERR_MODULE_NOT_FOUND in the image. ` +
        `Add an explicit negation: !${file}`
    ).toBe(false);
  });
});

describe('.dockerignore matcher', () => {
  // Verified against real Docker behaviour by exporting a synthetic build
  // context; `**` spanning zero directories is the case a naive
  // segment-by-segment translation gets wrong, and getting it wrong makes the
  // checks above pass vacuously.
  it.each([
    ['**/*.test.ts', 'a.test.ts', true],
    ['**/*.test.ts', 'src/db/a.test.ts', true],
    ['foo/**/bar.ts', 'foo/bar.ts', true],
    ['foo/**/bar.ts', 'foo/deep/bar.ts', true],
    ['*.sh', 'audit.sh', true],
    // Unlike git, a bare pattern anchors at the context root.
    ['*.sh', 'scripts/audit.sh', false],
    ['scripts', 'scripts/mark-warmups.ts', true],
    ['scripts', 'scripts-other/x.ts', false],
    ['temp?', 'tempa', true],
    ['temp?', 'temp', false],
  ])('%s vs %s', (pattern, path, expected) => {
    expect(toMatcher(pattern).test(path)).toBe(expected);
  });
});
