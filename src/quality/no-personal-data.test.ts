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

const scanStructural = (file: string, content: string): Finding[] => {
  const findings: Finding[] = [];
  content.split('\n').forEach((text, index) => {
    for (const [pattern, check] of [
      [HOME_PATH, 'home-directory path with a real user segment'],
      [WSL_UNC, 'WSL UNC path naming a real distro'],
    ] as const) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (isPlaceholder(match[1])) continue;
        findings.push({ file, line: index + 1, check });
      }
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
    .filter(Boolean)
    .filter((f) => !SKIP.some((skip) => f === skip || f.startsWith(skip)));

/** Binary files have no lines worth scanning and would produce garbage tokens. */
const readTextFile = (file: string): string | null => {
  const buffer = readFileSync(join(repoRoot, file));
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
};

const scanRepository = (): Finding[] => {
  const banned = loadTermHashes();
  const findings: Finding[] = [];
  for (const file of trackedFiles()) {
    const content = readTextFile(file);
    if (content === null) continue;
    findings.push(...scanStructural(file, content), ...scanTerms(file, content, banned));
  }
  return findings;
};

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

    it('skipped only files on the documented skip list', () => {
      const unexpected = scan.skipped.filter((s) => s.reason !== 'skip-list');
      expect(unexpected, describeCoverage(scan)).toEqual([]);
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
      expect(scanStructural('f', 'scp f realperson@realbox.local:/tmp')).toHaveLength(1);
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
