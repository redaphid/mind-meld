// Mechanical guard for issue #64: this repository is PUBLIC and must never
// contain personal information — home-directory paths, host/device names,
// machine topology, or credentials.
//
// A policy that lives only in a document is not enforced. This test scans every
// git-tracked file and fails the build when a personal-data pattern appears.
//
// Two independent checks:
//
//   1. STRUCTURAL — path shapes whose user/distro segment is a real name rather
//      than a documented placeholder. This needs no list of secrets to work, so
//      it catches values nobody has thought to add to a denylist yet.
//
//   2. TERM — exact tokens listed in quality/personal-terms.json. That file
//      holds SHA-256 hashes, never plaintext, so the guard does not reproduce
//      the very values it exists to keep out of the repo.
//
// Failures report FILE AND LINE ONLY. They never echo the offending text —
// printing it into CI logs would re-publish the leak while reporting it.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

/** Segments that are obviously stand-ins rather than a real person or machine. */
const PLACEHOLDERS = new Set([
  'you', 'your-username', 'your-user', 'user', 'username', 'users', 'me', 'u',
  'someone', 'somebody', 'alice', 'bob', 'example', 'test', 'dev', 'demo',
  'root', 'node', 'runner', 'ubuntu', 'distro', 'your-distro', 'name',
  'localhost',
]);

/**
 * Machine names that describe a platform or a role rather than a device. These
 * are only accepted where a machine name is expected — keeping them out of
 * PLACEHOLDERS means `/home/windows` is still a finding.
 */
const GENERIC_MACHINE_NAMES = new Set([
  'wsl', 'windows', 'linux', 'macos', 'mac', 'darwin', 'docker', 'container',
  'ci', 'local', 'localhost', 'host', 'hostname', 'server', 'machine',
  'default', 'unknown', 'none',
]);

/**
 * Trailing role words in an mDNS label: `ollama-host.local` names the job a
 * box does, not the box. Device-type words (`macbook`, `laptop`) are NOT here
 * — those pair with a personal name far more often than not.
 */
const HOST_ROLE_WORDS = new Set(['host', 'hostname', 'server']);

/** `pnpm@latest`, `image@stable` — a dist-tag after `@` is a version, not a box. */
const DIST_TAGS = new Set([
  'latest', 'stable', 'next', 'beta', 'alpha', 'canary', 'edge', 'nightly',
  'main', 'master', 'head',
]);

/** Paths that are noise to scan: vendored code, lockfiles, binaries, this guard. */
const SKIP = [
  'pnpm-lock.yaml',
  'public/vendor/',
  'quality/personal-terms.json',
  'src/quality/no-personal-data.test.ts',
];

/**
 * A placeholder may be bare (`you`), bracketed (`<you>`), or a shell variable
 * (`$USER`, `${USER}`, `%USERNAME%`). Normalize before comparing.
 */
const isPlaceholder = (segment: string): boolean => {
  const bare = segment
    .toLowerCase()
    .replace(/^[<{[(]+|[>}\])]+$/g, '')
    .replace(/^\$\{?|\}?$/g, '')
    .replace(/^%|%$/g, '');
  // `C:\Users\...` in prose elides the name rather than revealing one, and
  // `/home/%` (SQL LIKE) or `/home/*` (glob) match every user, naming none.
  if (/^[.*%]*$/.test(bare)) return true;
  return PLACEHOLDERS.has(bare);
};

type Finding = { file: string; line: number; check: string };

/** Home directories on every platform, plus the WSL view of a Windows home. */
const HOME_PATH =
  /(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}|\/mnt\/[a-z]\/Users\/)([A-Za-z0-9._$<>{}%()[\]-]+)/g;

/** \\wsl$\<distro>\... and \\wsl.localhost\<distro>\... — the distro names a machine. */
const WSL_UNC = /\\\\wsl(?:\$|\.localhost)\\+([^\\\s"'`]+)/gi;

/**
 * `~alice/...` — the same leak as /home/alice, written shorter. `~/` names
 * nobody, and the segment must start like a username so approximations
 * (`~265KB/day`) are not usernames.
 *
 * A `${...}` interpolation is matched as ONE bounded unit so a segment cannot
 * run past its closing brace. Without that bound, `~${fmtDuration(x)}</span>`
 * — the idiomatic way to render "retries in ~5m" — reads as a home path: the
 * segment swallows `{fmtDuration(x)}<` and the `/` of the closing tag
 * terminates it. The tilde there is an approximation sign, and everything the
 * segment ate is markup. Three sites in this repo already write `~${...}`; the
 * two that do not fire escape only on incidental whitespace, so this is a
 * recurring false positive, not a one-off.
 *
 * This narrows where a segment ENDS, never which names count. The
 * interpolation is still handed to isPlaceholder, so `~${USER}/` passes as a
 * placeholder and `~${REALNAME}/` is still a finding — a variable named after
 * a person leaks that person.
 *
 * The `(?!\$\{)` guard on the second branch is load-bearing: alternation
 * backtracks, so without it the greedy branch simply re-eats the interpolation
 * the first branch just declined and the false positive returns.
 */
const TILDE_HOME =
  /(?<![\w~/\\.-])~(\$\{[^}]*\}|(?!\$\{)[A-Za-z_$<{%([][A-Za-z0-9._$<>{}%()[\]-]*)\//g;

/**
 * Claude Code stores a project under a directory name that is its path with
 * every separator replaced by a hyphen (`decodeProjectPath`,
 * src/parsers/claude-messages.ts). That is a home path the HOME_PATH regex
 * cannot see, and it is the natural shape for a fixture copied from a real
 * transcript — the most likely future leak here. Decode, then reuse the check.
 */
const ENCODED_HOME = /-(?:Users|home)-[A-Za-z0-9._$<>{}%()[\]-]+/gi;
const decodeEncodedPath = (encoded: string): string => encoded.replace(/-/g, '/');

/**
 * `<label>.local` is mDNS: the label is a device name. Excluded by the
 * boundaries: `wsl.localhost` (longer word), `docker-compose.local.yml` and
 * `.env.local` (a file-name segment, not a hostname).
 */
const MDNS = /(?<![\w.-])([A-Za-z0-9][A-Za-z0-9-]*)\.local(?![\w.-])/g;

/**
 * `user@host` with a bare host. A version (`pnpm@10.11.0`), an action ref
 * (`actions/checkout@v4`) and an email (`x@example.com`) are excluded by
 * requiring a letter-led host with no dot other than a trailing `.local`.
 */
const USER_AT_HOST =
  /(?<![\w@/.-])([A-Za-z][A-Za-z0-9._-]*)@([A-Za-z][A-Za-z0-9-]*(?:\.local)?)(?![\w.@-])/g;

/**
 * A machine-name assignment holding a literal. Device names were the largest
 * leak category in the scrub; hashing the known ones defends the past, this
 * defends the shape. A value deferred to the environment (`${VAR:?...}`) names
 * nobody — only a hardcoded default is a finding.
 */
const MACHINE_ASSIGNMENT =
  /\b(?:MACHINE|DEVICE|COMPUTER|HOST)_?NAME[A-Z0-9_]*\s*[:=]\s*["']?([^\s"',]+)/g;

/** `${VAR:-fallback}` leaks the fallback; `${VAR:?msg}` and `$VAR` leak nothing. */
const literalOf = (value: string): string | null => {
  if (!value.includes('$')) return value;
  const withDefault = /\$\{[A-Za-z0-9_]+:-([^}]*)\}/.exec(value);
  return withDefault ? withDefault[1] : null;
};

const scanStructural = (file: string, content: string): Finding[] => {
  const findings: Finding[] = [];
  const add = (line: number, check: string) => findings.push({ file, line, check });

  content.split('\n').forEach((text, index) => {
    const line = index + 1;

    for (const [pattern, check] of [
      [HOME_PATH, 'home-directory path with a real user segment'],
      [WSL_UNC, 'WSL UNC path naming a real distro'],
      [TILDE_HOME, 'tilde home path naming a real user'],
    ] as const) {
      for (const match of text.matchAll(pattern)) {
        if (!isPlaceholder(match[1])) add(line, check);
      }
    }

    for (const match of text.matchAll(ENCODED_HOME)) {
      const decoded = decodeEncodedPath(match[0]);
      for (const inner of decoded.matchAll(HOME_PATH)) {
        if (!isPlaceholder(inner[1])) {
          add(line, 'encoded project-directory path with a real user segment');
        }
      }
    }

    for (const match of text.matchAll(MDNS)) {
      const label = match[1].toLowerCase();
      const lastWord = label.split('-').at(-1) ?? label;
      if (isPlaceholder(label) || GENERIC_MACHINE_NAMES.has(label)) continue;
      if (HOST_ROLE_WORDS.has(lastWord)) continue;
      add(line, 'mDNS name identifying a device');
    }

    for (const match of text.matchAll(USER_AT_HOST)) {
      const host = match[2].toLowerCase().replace(/\.local$/, '');
      // A dist-tag is a version; parts under three characters are stand-ins
      // (`t@t` in a fixture), not a person on a machine.
      if (DIST_TAGS.has(host) || host.length < 3 || match[1].length < 3) continue;
      const userNamesNobody = isPlaceholder(match[1]);
      const hostNamesNobody = isPlaceholder(host) || GENERIC_MACHINE_NAMES.has(host);
      if (userNamesNobody && hostNamesNobody) continue;
      add(line, 'user@host naming a person and a machine');
    }

    for (const match of text.matchAll(MACHINE_ASSIGNMENT)) {
      const literal = literalOf(match[1]);
      if (literal === null) continue;
      const name = literal.replace(/["'}]+$/, '').toLowerCase();
      if (!name || isPlaceholder(name) || GENERIC_MACHINE_NAMES.has(name)) continue;
      add(line, 'machine-name assignment holding a literal device name');
    }
  });
  return findings;
};

const loadTermHashes = (): Set<string> => {
  const raw = readFileSync(join(repoRoot, 'quality', 'personal-terms.json'), 'utf8');
  return new Set<string>(JSON.parse(raw).terms);
};

// Tokens repeat heavily across a repo; hashing each one once keeps the
// whole-repo scan fast enough that nobody is tempted to skip it.
const hashCache = new Map<string, string>();
const hash = (token: string): string => {
  const cached = hashCache.get(token);
  if (cached !== undefined) return cached;
  const digest = createHash('sha256').update(token).digest('hex');
  hashCache.set(token, digest);
  return digest;
};

const scanTerms = (file: string, content: string, banned: Set<string>): Finding[] => {
  const findings: Finding[] = [];
  content.split('\n').forEach((text, index) => {
    for (const token of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
      if (!banned.has(hash(token))) continue;
      findings.push({ file, line: index + 1, check: 'banned personal term' });
    }
  });
  return findings;
};

const trackedFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

const isSkipListed = (file: string): boolean =>
  SKIP.some((skip) => file === skip || file.startsWith(skip));

/**
 * Decode a file to text, or null if it is genuinely binary.
 *
 * "Contains a NUL byte" is NOT the same as binary: UTF-16 text is half NUL by
 * construction, and this repo handles UTF-16LE content. Treating it as binary
 * would silently exempt a real text file from the guard, so BOM-marked UTF-16
 * is decoded rather than skipped.
 */
const decodeText = (buffer: Buffer): string | null => {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      const swapped = Buffer.from(buffer.subarray(2));
      swapped.swap16();
      return swapped.toString('utf16le');
    }
  }
  // No BOM: a run of NULs at odd and even offsets alike is real binary.
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
};

type Skipped = { file: string; reason: 'skip-list' | 'binary' };
type Scan = { findings: Finding[]; scanned: number; skipped: Skipped[] };

const scanRepository = (): Scan => {
  const banned = loadTermHashes();
  const findings: Finding[] = [];
  const skipped: Skipped[] = [];
  let scanned = 0;

  for (const file of trackedFiles()) {
    if (isSkipListed(file)) {
      skipped.push({ file, reason: 'skip-list' });
      continue;
    }
    const content = decodeText(readFileSync(join(repoRoot, file)));
    if (content === null) {
      skipped.push({ file, reason: 'binary' });
      continue;
    }
    scanned += 1;
    findings.push(...scanStructural(file, content), ...scanTerms(file, content, banned));
  }
  return { findings, scanned, skipped };
};

/** What the guard looked at, so "it passed" cannot mean "it looked at nothing". */
const describeCoverage = (scan: Scan): string =>
  [
    `Scanned ${scan.scanned} tracked file(s); skipped ${scan.skipped.length}.`,
    'A guard that cannot say what it did not scan cannot be trusted to be non-empty.',
    '',
    ...scan.skipped.map((s) => `  ${s.file} — ${s.reason}`),
  ].join('\n');

/** Location + rule only. Never the matched text — that would re-leak it. */
const describeFindings = (findings: Finding[]): string =>
  [
    `${findings.length} personal-data finding(s) in tracked files.`,
    'This repo is PUBLIC (issue #64): no usernames, home paths, or machine names.',
    'Replace the value with a documented placeholder — do not delete the docs.',
    '',
    ...findings.map((f) => `  ${f.file}:${f.line} — ${f.check}`),
  ].join('\n');

describe('public repository contains no personal data', () => {
  const scan = scanRepository();

  it('has no personal paths, machine names, or operator identifiers', () => {
    expect(scan.findings.length, describeFindings(scan.findings)).toBe(0);
  });

  // A guard that quietly declines to look is worse than one that admits it.
  // Skips are accounted for, and the scan is asserted non-empty, so a refactor
  // that scans nothing fails instead of passing.
  describe('coverage accounting', () => {
    it('scanned essentially every tracked file', () => {
      expect(scan.scanned, describeCoverage(scan)).toBeGreaterThan(150);
    });

    it('skipped only the skip list and genuinely binary formats', () => {
      // The point is not that nothing is skipped — it is that nothing is
      // skipped for a reason nobody can name. A text file landing here is a
      // hole in the guard, so it has to fail rather than pass quietly.
      const binaryFormats = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|wasm)$/i;
      const unexplained = scan.skipped.filter(
        (s) => s.reason !== 'skip-list' && !binaryFormats.test(s.file),
      );
      expect(unexplained, describeCoverage(scan)).toEqual([]);
    });

    it('reads UTF-16LE text rather than skipping it as binary', () => {
      // This repo handles UTF-16LE content, so "has a NUL byte, must be
      // binary" would silently exempt a real text file from the guard.
      const utf16 = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('/home/realperson/.claude', 'utf16le'),
      ]);
      expect(decodeText(utf16)).toBe('/home/realperson/.claude');
      expect(decodeText(Buffer.from([0x00, 0x01, 0x02, 0x00]))).toBeNull();
    });
  });

  // The guard is only worth having if it actually fires. These pin the
  // behaviour so a future refactor cannot quietly turn it into a no-op.
  describe('detection', () => {
    it('flags a real home directory but not a placeholder one', () => {
      expect(scanStructural('f', '/home/somebodyreal/.claude')).toHaveLength(1);
      expect(scanStructural('f', '/home/you/.claude')).toHaveLength(0);
      expect(scanStructural('f', '/home/<user>/.claude')).toHaveLength(0);
    });

    it('flags real macOS and Windows home directories', () => {
      expect(scanStructural('f', '/Users/realperson/Projects')).toHaveLength(1);
      expect(scanStructural('f', 'C:\\Users\\realperson\\.claude')).toHaveLength(1);
      expect(scanStructural('f', '/mnt/c/Users/realperson/.claude')).toHaveLength(1);
    });

    it('flags WSL UNC paths naming a real distro', () => {
      expect(scanStructural('f', '\\\\wsl.localhost\\SomeDistro\\home')).toHaveLength(1);
      expect(scanStructural('f', '\\\\wsl$\\SomeDistro\\home')).toHaveLength(1);
      expect(scanStructural('f', '\\\\wsl.localhost\\<distro>\\home')).toHaveLength(0);
    });

    it('leaves legitimate non-personal paths alone', () => {
      expect(scanStructural('f', '/root/.claude:ro')).toHaveLength(0);
      expect(scanStructural('f', '/mnt/c/Projects/app')).toHaveLength(0);
      expect(scanStructural('f', 'D:\\projects\\app')).toHaveLength(0);
    });

    it('treats wildcards and elisions as naming nobody', () => {
      expect(scanStructural('f', "path LIKE '/home/%'")).toHaveLength(0);
      expect(scanStructural('f', 'rm -rf /home/*/tmp')).toHaveLength(0);
      expect(scanStructural('f', 'rejects C:\\Users\\... volume specs')).toHaveLength(0);
    });

    // Gaps found by adversarial review of PR #92. Each shape below is one a
    // real leak arrived in (or is the shape this codebase most naturally
    // produces), and each is mechanical — it needs no denylist to catch.

    it('flags the encoded project-directory form Claude Code writes', () => {
      // `decodeProjectPath` (src/parsers/claude-messages.ts) turns
      // `-Users-x-Projects-y` back into `/Users/x/Projects/y`. A fixture copied
      // from a real transcript arrives in the encoded form, where the path
      // separators are hyphens — so the plain home-path check never sees it.
      expect(scanStructural('f', '-Users-realperson-Projects-app')).toHaveLength(1);
      expect(scanStructural('f', '-home-realperson-code')).toHaveLength(1);
      expect(scanStructural('f', '-Users-you-Projects-acme')).toHaveLength(0);
      expect(scanStructural('f', '-home-user-code')).toHaveLength(0);
    });

    it('flags the tilde home form', () => {
      expect(scanStructural('f', '~realperson/.claude')).toHaveLength(1);
      expect(scanStructural('f', 'cp x ~realperson/dst')).toHaveLength(1);
      expect(scanStructural('f', '~/.claude')).toHaveLength(0);
      expect(scanStructural('f', '~you/.claude')).toHaveLength(0);
      expect(scanStructural('f', '~<user>/.claude')).toHaveLength(0);
    });

    it('reads ~${...} as an approximation without going blind to real names', () => {
      // "retries in ~5m" is written `~${fmtDuration(x)}` and sits next to a
      // closing tag. The tilde is an approximation sign; the segment the
      // unbounded pattern captured — `{fmtDuration(x)}<` — was markup, and the
      // `/` that terminated it belonged to `</span>`. Nothing here names anyone.
      const chip =
        'html`<span class="right faint nowrap">retries in ~${fmtDuration(held.resumesIn)}</span>`';
      expect(scanStructural('f', chip)).toHaveLength(0);
      expect(scanStructural('f', 'html`<span>~${etaText} remaining</span>`')).toHaveLength(0);
      // Same shape with a real `/` inside the interpolation: the segment ends
      // at `}`, so the division sign is not a path separator either.
      expect(scanStructural('f', '`~${Math.round(summary.length/4)} tokens`')).toHaveLength(0);

      // The bound moved where a segment ENDS, not which names count. A tilde
      // home path still leaks — including inside the very markup above — and
      // an interpolation named after a person still leaks that person.
      expect(scanStructural('f', 'html`<a href="~realperson/notes">x</a>`')).toHaveLength(1);
      expect(scanStructural('f', '~${REALNAME}/.claude')).toHaveLength(1);
      expect(scanStructural('f', '~${USER}/.claude')).toHaveLength(0);
    });

    it('flags mDNS names, which name a device', () => {
      expect(scanStructural('f', 'OLLAMA_URL=http://realbox.local:11434')).toHaveLength(1);
      expect(scanStructural('f', 'ssh realbox.local')).toHaveLength(1);
      // Role words name a role, not a device; and these are not mDNS at all.
      expect(scanStructural('f', 'http://ollama-host.local:11434')).toHaveLength(0);
      expect(scanStructural('f', 'docker-compose.local.yml')).toHaveLength(0);
      expect(scanStructural('f', '.env.local')).toHaveLength(0);
      expect(scanStructural('f', '\\\\wsl.localhost\\<distro>\\home')).toHaveLength(0);
    });

    it('flags user@host, the shape one removed value had', () => {
      expect(scanStructural('f', 'ssh realperson@realbox')).toHaveLength(1);
      // Both the user@host and the mDNS rule fire here; either alone stops it.
      expect(scanStructural('f', 'scp f realperson@realbox.local:/tmp')).toHaveLength(2);
      // Versions, emails and action refs are not people at hosts.
      expect(scanStructural('f', '"packageManager": "pnpm@10.11.0"')).toHaveLength(0);
      expect(scanStructural('f', 'uses: actions/checkout@v4')).toHaveLength(0);
      expect(scanStructural('f', 'Co-Authored-By: X <noreply@anthropic.com>')).toHaveLength(0);
      expect(scanStructural('f', 'contact: someone@example.com')).toHaveLength(0);
      expect(scanStructural('f', 'user@localhost')).toHaveLength(0);
    });

    it('flags a machine-name assignment holding a literal name', () => {
      // Device names were this PR's largest leak category. Hashing the two
      // known ones defends the past; this defends the shape, so tomorrow's
      // machine is caught without anyone remembering to add a hash.
      expect(scanStructural('f', 'MACHINE_NAME=realbox')).toHaveLength(1);
      expect(scanStructural('f', '      MACHINE_NAME: ${MACHINE_NAME_WSL:-realbox}')).toHaveLength(1);
      expect(scanStructural('f', 'DEVICE_NAME: "realbox"')).toHaveLength(1);
      // Generic names, and values deferred to the environment, name nobody.
      expect(scanStructural('f', 'MACHINE_NAME=windows')).toHaveLength(0);
      expect(scanStructural('f', 'MACHINE_NAME_WSL=wsl')).toHaveLength(0);
      expect(scanStructural('f', 'MACHINE_NAME: ${MACHINE_NAME:?required}')).toHaveLength(0);
      expect(scanStructural('f', 'machine: getEnv("MACHINE_NAME", hostname())')).toHaveLength(0);
    });

    it('flags a banned term as a whole token only', () => {
      const banned = new Set([hash('bannedname')]);
      expect(scanTerms('f', 'host: bannedname.local', banned)).toHaveLength(1);
      expect(scanTerms('f', 'host: BannedName', banned)).toHaveLength(1);
      expect(scanTerms('f', 'unbannednamed things', banned)).toHaveLength(0);
    });

    it('reports location without echoing the offending value', () => {
      const message = describeFindings([{ file: 'a.ts', line: 7, check: 'banned personal term' }]);
      expect(message).toContain('a.ts:7');
    });
  });
});
