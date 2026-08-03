// Mechanical guard for issue #113: the service worker's cache key is a
// hand-maintained constant, so a shell asset can change while installed
// clients keep serving the copy they already have.
//
// public/sw.js precaches a SHELL list into a cache named from VERSION
// (`mindmeld-shell-${VERSION}`). Nothing re-fetches those entries until that
// name changes. For the entries still served cache-first (the icons and the
// manifest) a missed bump is not "slow to update", it is "never". For the
// rest, the stale copy is what every offline / tunnel-down load falls back to,
// and it is what the old cache keeps until VERSION retires it.
//
// CLAUDE.md documents the rule ("Bump VERSION in public/sw.js when shell files
// change") and nothing enforced it. Commit 34a5576 exists because it was
// missed once already. A convention that must be remembered on every UI change
// will be missed again, so this makes it mechanical (issue #61).
//
// Three independent checks:
//
//   1. DIGEST — every asset listed in SHELL is hashed and compared against
//      quality/service-worker-shell.json. Content that moved without a VERSION
//      bump fails here.
//   2. COVERAGE — every public/js/**/*.js module appears in SHELL. A new view
//      nobody listed is simply never precached, and nothing says so.
//   3. LIVENESS — every SHELL entry exists on disk. sw.js installs with
//      Promise.allSettled (sw.js:39) so a 404 is swallowed by design: a dead
//      path would otherwise fail silently forever.
//
// NO BUILD STEP is added or implied. This reads the committed files and
// compares them to a committed digest; what is committed is still exactly what
// is served (CLAUDE.md: "edit a file, reload the page").
//
// Failures name PATHS ONLY, never file contents — this repo's CI logs are
// public (issue #64), the same rule no-personal-data.test.ts follows.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

const SW_SOURCE_PATH = 'public/sw.js';
const DIGEST_PATH = 'quality/service-worker-shell.json';
const UPDATE_COMMAND = 'pnpm run quality:sw-shell -- --update';

/** The digest as committed: the VERSION it was taken at, and one hash per SHELL entry. */
type ShellDigest = { version: string; shell: Record<string, string> };

/** null = listed in SHELL but not present on disk. */
type AssetHashes = Record<string, string | null>;

const read = (repoPath: string): string => readFileSync(join(repoRoot, repoPath), 'utf8');

// --- parsing public/sw.js -------------------------------------------------
//
// Parsed, never imported or evaluated: sw.js is browser code that touches
// `self` on load. Regex over the source keeps this test free of any runtime
// for the service worker, which is the whole point of having no build step.

const parseVersion = (source: string): string | null =>
  /^\s*const\s+VERSION\s*=\s*['"]([^'"]+)['"]/m.exec(source)?.[1] ?? null;

const parseShell = (source: string): string[] | null => {
  const block = /^\s*const\s+SHELL\s*=\s*\[([\s\S]*?)\]/m.exec(source);
  if (!block) return null;
  return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
};

// --- hashing --------------------------------------------------------------

/**
 * SHELL holds URL paths. Everything maps 1:1 into public/, except `/`, which
 * the server answers with index.html.
 */
const toRepoPath = (url: string): string => (url === '/' ? 'public/index.html' : `public${url}`);

const exists = (repoPath: string): boolean => {
  try {
    return statSync(join(repoRoot, repoPath)).isFile();
  } catch {
    return false;
  }
};

/**
 * Text is hashed with line endings normalized to LF; binary is hashed raw.
 *
 * This repo has core.autocrlf checkouts (only .github/workflows/*.yml is
 * pinned in .gitattributes), so the same commit has CRLF in a Windows working
 * tree and LF on the Linux CI runner. Hashing raw bytes would therefore record
 * a digest that only matches on the OS that wrote it — the guard would fail
 * for a reason that has nothing to do with the shell being stale.
 *
 * "Contains a NUL byte" is git's own text/binary heuristic, and it is what
 * decides whether git rewrote the endings in the first place, so it is the
 * right question to ask here. It keeps the PNG icons byte-exact (a PNG can
 * legitimately contain 0x0D 0x0A) while making every text asset portable.
 */
const hashAsset = (buffer: Buffer): string => {
  const body = buffer.includes(0)
    ? buffer
    : Buffer.from(buffer.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
  return createHash('sha256').update(body).digest('hex');
};

const hashShell = (urls: string[]): AssetHashes =>
  Object.fromEntries(
    urls.map((url) => {
      const repoPath = toRepoPath(url);
      return [url, exists(repoPath) ? hashAsset(readFileSync(join(repoRoot, repoPath))) : null];
    }),
  );

// --- what is on disk ------------------------------------------------------

/** Every .js under public/js, as the URL sw.js would have to list. Vendored code is not ours. */
const publicJsUrls = (): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'vendor') return [];
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(child);
      return entry.name.endsWith('.js') ? [child] : [];
    });
  return walk('public/js')
    .map((repoPath) => repoPath.replace(/^public/, ''))
    .sort();
};

// --- drift reporting ------------------------------------------------------

type Status = 'changed' | 'added' | 'removed' | 'missing';
type Drift = { url: string; status: Status };

const diffDigest = (recorded: Record<string, string>, current: AssetHashes): Drift[] => {
  const drift: Drift[] = [];
  for (const [url, hash] of Object.entries(current)) {
    if (hash === null) drift.push({ url, status: 'missing' });
    else if (!(url in recorded)) drift.push({ url, status: 'added' });
    else if (recorded[url] !== hash) drift.push({ url, status: 'changed' });
  }
  for (const url of Object.keys(recorded)) {
    if (!(url in current)) drift.push({ url, status: 'removed' });
  }
  return drift;
};

/**
 * The fix, spelled out. A quality check that only says "no" costs more than it
 * saves, so this names the files, the constant, and the exact command.
 *
 * The advice splits on whether VERSION has already moved, because the two
 * cases need opposite actions and telling someone to bump a constant they just
 * bumped is how a guard teaches people to stop reading it. Merging a branch
 * that legitimately bumped VERSION lands in the second case.
 *
 * Paths and statuses only. Never contents, never a diff.
 */
const describeDrift = (drift: Drift[], version: string, recordedVersion: string): string =>
  [
    `${drift.length} service-worker shell asset(s) no longer match ${DIGEST_PATH}.`,
    '',
    `public/sw.js precaches these under \`mindmeld-shell-${version}\`. An installed`,
    'client does not re-fetch them until that cache name changes, so shipping a',
    'change without bumping VERSION leaves existing clients on the old bytes.',
    '',
    ...(recordedVersion === version
      ? [
          'To fix:',
          `  1. Bump VERSION in ${SW_SOURCE_PATH} (still '${version}', as when the digest was recorded).`,
          `  2. Run: ${UPDATE_COMMAND}`,
          `  3. Commit ${DIGEST_PATH} alongside your change.`,
        ]
      : [
          `VERSION has already moved ('${recordedVersion}' -> '${version}'), so clients will`,
          'pick these up. Only the digest is behind:',
          `  1. Run: ${UPDATE_COMMAND}`,
          `  2. Commit ${DIGEST_PATH} alongside your change.`,
        ]),
    '',
    ...drift.map((d) => `  ${d.status.padEnd(8)} ${d.url}`),
    '',
    '(Paths only — this repo is public, so contents are never printed.)',
  ].join('\n');

// --- the guard ------------------------------------------------------------

describe('service worker shell is not silently stale', () => {
  const source = read(SW_SOURCE_PATH);
  const version = parseVersion(source);
  const shell = parseShell(source);
  const digest = JSON.parse(read(DIGEST_PATH)) as ShellDigest;

  // A guard that parsed nothing would pass everything. Assert it read a real
  // SHELL before trusting any result derived from it.
  describe('reads public/sw.js', () => {
    it('parses VERSION', () => {
      expect(version, `No \`const VERSION = '...'\` found in ${SW_SOURCE_PATH}.`).toMatch(/^v\d+$/);
    });

    it('parses a non-empty SHELL list', () => {
      expect(shell, `No \`const SHELL = [...]\` found in ${SW_SOURCE_PATH}.`).not.toBeNull();
      expect(shell?.length, 'SHELL parsed as empty — the guard would check nothing.').toBeGreaterThan(10);
    });
  });

  it('matches the recorded digest, or VERSION has been bumped', () => {
    const drift = diffDigest(digest.shell, hashShell(shell ?? []));
    expect(drift, describeDrift(drift, version ?? '?', digest.version)).toEqual([]);
  });

  it('records the VERSION the digest was taken at', () => {
    // Both directions, like the knip ratchet: a digest recorded against a
    // VERSION that no longer exists is stale even when every hash still
    // matches, and a stale baseline is one nobody can trust.
    expect(
      digest.version,
      [
        `${DIGEST_PATH} was recorded at VERSION '${digest.version}', but ${SW_SOURCE_PATH}`,
        `now says '${version}'. Re-record it so the digest describes the shipped shell:`,
        `  ${UPDATE_COMMAND}`,
      ].join('\n'),
    ).toBe(version);
  });

  it('lists every public/js module in SHELL', () => {
    // A view that is not listed is never precached, and nothing anywhere says
    // so — the omission is invisible until someone loads the app offline.
    const listed = new Set(shell ?? []);
    const unlisted = publicJsUrls().filter((url) => !listed.has(url));
    expect(
      unlisted,
      [
        `${unlisted.length} module(s) under public/js are not in the SHELL list in ${SW_SOURCE_PATH},`,
        'so the service worker never precaches them and they are unavailable offline.',
        '',
        `Add them to SHELL, bump VERSION, then run: ${UPDATE_COMMAND}`,
        '',
        ...unlisted.map((url) => `  ${url}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('lists only paths that exist on disk', () => {
    // sw.js:39 installs with Promise.allSettled so one 404 cannot abort the
    // whole install. The cost of that deliberate tolerance is that a renamed
    // or deleted asset stays in SHELL forever, failing silently on every
    // install. Nothing but this check will ever mention it.
    const dead = (shell ?? []).filter((url) => !exists(toRepoPath(url)));
    expect(
      dead,
      [
        `${dead.length} SHELL entr(y/ies) in ${SW_SOURCE_PATH} do not exist under public/.`,
        'sw.js installs with Promise.allSettled, so these 404 silently on every install',
        'and are never cached. Remove or correct them, then bump VERSION.',
        '',
        ...dead.map((url) => `  ${url} -> ${toRepoPath(url)}`),
      ].join('\n'),
    ).toEqual([]);
  });

  // The guard is only worth having if it actually fires. These pin the
  // behaviour so a future refactor cannot quietly turn it into a no-op.
  describe('detection', () => {
    it('parses the real shape of sw.js and rejects a file with neither', () => {
      const sample = "const VERSION = 'v9'\nconst SHELL = [\n  '/',\n  '/app.css',\n]\n";
      expect(parseVersion(sample)).toBe('v9');
      expect(parseShell(sample)).toEqual(['/', '/app.css']);
      expect(parseVersion('const OTHER = 1')).toBeNull();
      expect(parseShell('const OTHER = 1')).toBeNull();
    });

    it('flags a changed, added, removed or missing asset', () => {
      const recorded = { '/a.js': 'aaa', '/b.js': 'bbb', '/gone.js': 'ggg' };
      expect(diffDigest(recorded, { '/a.js': 'aaa', '/b.js': 'zzz', '/c.js': 'ccc' })).toEqual([
        { url: '/b.js', status: 'changed' },
        { url: '/c.js', status: 'added' },
        { url: '/gone.js', status: 'removed' },
      ]);
      expect(diffDigest(recorded, { '/a.js': null })).toContainEqual({
        url: '/a.js',
        status: 'missing',
      });
    });

    it('passes only when every hash is identical', () => {
      const recorded = { '/a.js': 'aaa' };
      expect(diffDigest(recorded, { '/a.js': 'aaa' })).toEqual([]);
    });

    it('hashes text independently of line endings, and binary byte for byte', () => {
      // Without this the digest would only ever match on the OS that recorded
      // it: autocrlf gives a Windows tree CRLF and the CI runner LF.
      expect(hashAsset(Buffer.from('a\r\nb\r\n'))).toBe(hashAsset(Buffer.from('a\nb\n')));
      // A PNG may contain 0x0D 0x0A that is data, not a line ending.
      const png = Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a, 0x01]);
      const mangled = Buffer.from([0x89, 0x50, 0x00, 0x0a, 0x01]);
      expect(hashAsset(png)).not.toBe(hashAsset(mangled));
    });

    it('resolves SHELL urls to files under public/, with / as index.html', () => {
      expect(toRepoPath('/')).toBe('public/index.html');
      expect(toRepoPath('/js/views/search.js')).toBe('public/js/views/search.js');
    });

    it('reports what to do, naming the file and the command but no contents', () => {
      const drift: Drift[] = [{ url: '/js/views/search.js', status: 'changed' }];

      // VERSION untouched: the bump is the fix, the digest is the paperwork.
      const stale = describeDrift(drift, 'v11', 'v11');
      expect(stale).toContain('/js/views/search.js');
      expect(stale).toContain('Bump VERSION');
      expect(stale).toContain(UPDATE_COMMAND);

      // VERSION already bumped (e.g. merging a branch that did it): telling
      // someone to bump it again is advice they will correctly ignore.
      const bumped = describeDrift(drift, 'v12', 'v11');
      expect(bumped).toContain("already moved ('v11' -> 'v12')");
      expect(bumped).not.toContain('Bump VERSION');
      expect(bumped).toContain(UPDATE_COMMAND);
    });
  });
});
