#!/usr/bin/env tsx
/**
 * Service-worker shell digest — the recorded fingerprint of every precached asset.
 *
 * public/sw.js caches its SHELL list under a name built from a hand-maintained
 * `VERSION` constant. An installed client never re-fetches those assets until
 * that name changes, so editing a shell file without bumping VERSION strands
 * every existing client on the old copy (issue #113).
 *
 * quality/service-worker-shell.json records the VERSION and one hash per SHELL
 * entry. `src/quality/service-worker-freshness.test.ts` is the check — it runs
 * in the normal test suite and fails when reality drifts from that file. This
 * script is the other half: the deliberate, documented way to re-record it.
 *
 *   pnpm run quality:sw-shell              # report drift, exit 1 if stale
 *   pnpm run quality:sw-shell -- --update  # re-record the digest
 *
 * --update REFUSES to write while VERSION is unchanged. That is the entire
 * point: the only way to make the check green after touching a shell asset is
 * to bump VERSION, which is the thing that actually fixes the bug. Updating the
 * digest is not a way to silence the check, it is the second half of doing it
 * right. Deliberately not wired into `pnpm run quality:update`, so it can never
 * become part of a reflexive "re-baseline everything" pass.
 *
 * This adds NO build step (CLAUDE.md): it reads committed files and writes a
 * committed digest. What is committed is still exactly what is served.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SW_SOURCE_PATH = 'public/sw.js';
const DIGEST_PATH = 'quality/service-worker-shell.json';
const UPDATE = process.argv.includes('--update');

const inCI = process.env.GITHUB_ACTIONS === 'true';
const fail = (msg: string) =>
  console.error(inCI ? `::error title=sw shell digest::${msg}` : `ERROR: ${msg}`);

type ShellDigest = { version: string; shell: Record<string, string> };

// Kept deliberately in step with service-worker-freshness.test.ts. The test is
// the authority: it recomputes from scratch and rejects whatever this writes if
// the two ever disagree, so drift here surfaces immediately rather than rotting.
const parseVersion = (source: string): string | null =>
  /^\s*const\s+VERSION\s*=\s*['"]([^'"]+)['"]/m.exec(source)?.[1] ?? null;

const parseShell = (source: string): string[] | null => {
  const block = /^\s*const\s+SHELL\s*=\s*\[([\s\S]*?)\]/m.exec(source);
  if (!block) return null;
  return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
};

const toRepoPath = (url: string): string => (url === '/' ? 'public/index.html' : `public${url}`);

const exists = (repoPath: string): boolean => {
  try {
    return statSync(join(ROOT, repoPath)).isFile();
  } catch {
    return false;
  }
};

/** LF-normalized for text, raw for binary — see the note in the test for why. */
const hashAsset = (buffer: Buffer): string => {
  const body = buffer.includes(0)
    ? buffer
    : Buffer.from(buffer.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
  return createHash('sha256').update(body).digest('hex');
};

/** Every .js under public/js, as the URL sw.js would have to list. */
const publicJsUrls = (): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'vendor') return [];
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(child);
      return entry.name.endsWith('.js') ? [child] : [];
    });
  return walk('public/js')
    .map((repoPath) => repoPath.replace(/^public/, ''))
    .sort();
};

const source = readFileSync(join(ROOT, SW_SOURCE_PATH), 'utf8');
const version = parseVersion(source);
const shell = parseShell(source);

if (version === null || shell === null || shell.length === 0) {
  fail(
    `Could not parse VERSION and a non-empty SHELL from ${SW_SOURCE_PATH}. ` +
      'The digest describes that list, so it cannot be recorded without it.',
  );
  process.exit(1);
}

// A SHELL entry with no file behind it has no hash to record. sw.js installs
// with Promise.allSettled, so this 404s silently forever if nobody says so.
const dead = shell.filter((url) => !exists(toRepoPath(url)));
if (dead.length > 0) {
  fail(`${dead.length} SHELL entr(y/ies) in ${SW_SOURCE_PATH} do not exist under public/:`);
  for (const url of dead) console.error(`  ${url} -> ${toRepoPath(url)}`);
  console.error('Remove or correct them first — a path that 404s cannot be precached.');
  process.exit(1);
}

const listed = new Set(shell);
const unlisted = publicJsUrls().filter((url) => !listed.has(url));
if (unlisted.length > 0) {
  fail(`${unlisted.length} module(s) under public/js are missing from SHELL in ${SW_SOURCE_PATH}:`);
  for (const url of unlisted) console.error(`  ${url}`);
  console.error('Add them to SHELL first — an unlisted module is never precached.');
  process.exit(1);
}

const current = Object.fromEntries(
  shell.map((url) => [url, hashAsset(readFileSync(join(ROOT, toRepoPath(url))))]),
);

const recorded = JSON.parse(readFileSync(join(ROOT, DIGEST_PATH), 'utf8')) as ShellDigest;
const changed = Object.keys(current).filter((url) => recorded.shell[url] !== current[url]);
const removed = Object.keys(recorded.shell).filter((url) => !(url in current));
const drifted = changed.length > 0 || removed.length > 0;
const versionMoved = recorded.version !== version;

if (!drifted && !versionMoved) {
  console.log(`sw shell digest OK: ${shell.length} asset(s) match at VERSION '${version}'.`);
  process.exit(0);
}

// Paths only. This repo is public and so are its CI logs (issue #64).
const report = () => {
  for (const url of changed) console.error(`  changed  ${url}`);
  for (const url of removed) console.error(`  removed  ${url}`);
};

if (!UPDATE) {
  if (drifted) {
    fail(
      `${changed.length + removed.length} shell asset(s) differ from ${DIGEST_PATH}. ` +
        `Bump VERSION in ${SW_SOURCE_PATH} (currently '${version}'), then re-run with --update.`,
    );
    report();
  } else {
    fail(
      `${DIGEST_PATH} was recorded at VERSION '${recorded.version}' but ${SW_SOURCE_PATH} ` +
        `now says '${version}'. Re-run with --update to re-record it.`,
    );
  }
  process.exit(1);
}

if (drifted && !versionMoved) {
  fail(
    `--update refused: ${changed.length + removed.length} shell asset(s) changed, but VERSION is ` +
      `still '${version}' — the same value the digest was recorded at. Re-recording now would ` +
      'hide the bug instead of fixing it: installed clients would keep serving the old files.',
  );
  report();
  console.error('');
  console.error(`Bump VERSION in ${SW_SOURCE_PATH} first, then run this again.`);
  process.exit(1);
}

const next: ShellDigest = { version, shell: current };
writeFileSync(join(ROOT, DIGEST_PATH), JSON.stringify(next, null, 2) + '\n');
console.log(
  `sw shell digest re-recorded at VERSION '${version}'` +
    (versionMoved ? ` (was '${recorded.version}')` : '') +
    `: ${shell.length} asset(s), ${changed.length} changed, ${removed.length} removed.`,
);
console.log(`Commit ${DIGEST_PATH} with your change.`);
process.exit(0);
