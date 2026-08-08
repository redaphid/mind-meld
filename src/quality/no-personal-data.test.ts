// Mechanical guard for issue #64: this repository is PUBLIC and must never
// contain personal information — home-directory paths, host/device names,
// machine topology, or credentials.
//
// A policy that lives only in a document is not enforced. This test scans every
// git-tracked file and fails the build when a personal-data pattern appears.
//
// The detection itself lives in ./personal-data.mjs, shared with the
// pre-commit hook (.githooks/pre-commit) so the two cannot drift. This file
// owns the whole-repo sweep and the behavioural pins; the module owns the
// rules. Three tiers, described in full in the module header:
//
//   1. STRUCTURAL — path/machine shapes whose user segment is a real name.
//   2. TERM       — exact tokens, as SHA-256 hashes in quality/personal-terms.json.
//   3. IDENTIFIER — content quoted out of `dataClass: personal` records.
//
// The sweep below runs tiers 1 and 2 only. Tier 3 is pinned by unit tests here
// and enforced on staged additions by the hook, but is NOT yet run over the
// whole repo, because the repo does not currently pass it: docs/openapi.yaml
// carries `Uber Eats` and `Kia` example queries lifted from the operator's
// phone records. Turn the sweep on the moment those are replaced with invented
// queries — the wiring is one line, marked below.
//
// Failures report FILE AND LINE ONLY. They never echo the offending text —
// printing it into CI logs would re-publish the leak while reporting it.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeText,
  hash,
  isSkipListed,
  loadTermHashes,
  scanIdentifiers,
  scanStructural,
  scanTerms,
} from './personal-data.mjs';

const repoRoot = join(import.meta.dirname, '..', '..');

type Finding = { file: string; line: number; check: string };

const trackedFiles = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

type Skipped = { file: string; reason: 'skip-list' | 'binary' };
type Scan = { findings: Finding[]; scanned: number; skipped: Skipped[] };

const scanRepository = (): Scan => {
  const banned = loadTermHashes(repoRoot);
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
    // Add `...scanIdentifiers(file, content)` here once docs/openapi.yaml is
    // cleaned up — see the header.
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

  // Tier 3. The reason this exists: on 2026-08-07 an agent wrote an AGENTS.md
  // holding real session ids, real message ids and `Uber Eats` queries pulled
  // from `dataClass: personal` / `source: android` records — and tiers 1 and 2
  // returned ZERO findings on it, before and after the fix. They ask "did a
  // path or a known word leak"; nobody had asked "is this content quoted out
  // of his private records".
  describe('content quoted out of personal records', () => {
    it('flags bare ids in docs and accepts the placeholder form', () => {
      // The exact line that nearly shipped, and its sanitized replacement.
      expect(scanIdentifiers('AGENTS.md', 'Session: 104057  Message: 288314')).toHaveLength(2);
      expect(
        scanIdentifiers('AGENTS.md', 'Session: <SESSION_ID>  Message: <MESSAGE_ID>'),
      ).toHaveLength(0);
      expect(scanIdentifiers('AGENTS.md', 'sessionId=104057')).toHaveLength(1);
      expect(scanIdentifiers('AGENTS.md', 'session_id: 104057')).toHaveLength(1);
    });

    it('does not mistake counts, cardinals and JSON keys for ids', () => {
      // Each of these is real text from this repo's docs. A guard that fires
      // on them is a guard that gets --no-verify'd, so they are pinned.
      expect(scanIdentifiers('AGENTS.md', '`messageCount` — 185 android sessions')).toHaveLength(0);
      expect(
        scanIdentifiers('AGENTS.md', '{"code":-32000,"message":"Bad Request: No valid session ID"}'),
      ).toHaveLength(0);
      expect(scanIdentifiers('AGENTS.md', '`limit` (max 200), `offset`')).toHaveLength(0);
      expect(scanIdentifiers('AGENTS.md', 'one 8-chunk session received 24 passes')).toHaveLength(0);
      expect(scanIdentifiers('AGENTS.md', 'GET /api/sessions/<id>/messages')).toHaveLength(0);
    });

    it('gives code a higher id floor than prose, and says why in the floor', () => {
      // Test fixtures invent ids and this repo's are four digits, so firing on
      // them would train everyone to bypass the hook. Live ids are six.
      expect(scanIdentifiers('src/mcp/search.test.ts', 'session_id: 4268,')).toHaveLength(0);
      expect(scanIdentifiers('src/mcp/search.test.ts', 'session_id: 104057,')).toHaveLength(1);
      // Prose has no such excuse — the placeholder is free there.
      expect(scanIdentifiers('AGENTS.md', 'session_id: 4268')).toHaveLength(1);
    });

    it('flags a consumer app name used as an example query', () => {
      // Verbatim from docs/openapi.yaml, which still carries it.
      expect(
        scanIdentifiers('docs/x.md', 'q=what did I order from Uber Eats tonight'),
      ).toHaveLength(1);
      // Reported as the whole brand, not just `Uber` — alternation is sorted
      // longest-first so the finding says as much as it knows.
      expect(scanIdentifiers('docs/x.md', 'q=Uber Eats tonight')[0].excerpt).toContain('Ub');
      expect(scanIdentifiers('docs/x.md', 'q=Kia finds the message')).toHaveLength(1);
      expect(scanIdentifiers('docs/x.md', 'notif:com.ubercab.eats:Order delivered')).toHaveLength(2);
      // The documented placeholder shape names no app at all.
      expect(scanIdentifiers('docs/x.md', 'session `external_id` | `notif:<package>:<title>`')).toHaveLength(0);
    });

    it('leaves ordinary engineering vocabulary alone', () => {
      // Every one of these fired during tuning. `ring buffer` is in two source
      // files; the rest are the words a denylist of brand names swallows.
      expect(scanIdentifiers('f', 'In-memory ring buffer of console output')).toHaveLength(0);
      expect(scanIdentifiers('f', 'a nested, seamless calm signal from Amazon S3')).toHaveLength(0);
      expect(scanIdentifiers('f', 'posted to Slack and Discord via GitHub')).toHaveLength(0);
    });

    it('flags phone numbers, addresses, contacts and personal email', () => {
      expect(scanIdentifiers('f', 'call me at (555) 867-5309')).toHaveLength(1);
      expect(scanIdentifiers('f', 'ship to 1600 Pennsylvania Ave')).toHaveLength(1);
      expect(scanIdentifiers('f', 'contact: Jane Doe')).toHaveLength(1);
      expect(scanIdentifiers('f', 'mail me at jdoe@personaldomain.com')).toHaveLength(1);
      // `someone@` names nobody, so it is a placeholder, not a contact.
      expect(scanIdentifiers('f', 'mail me at someone@personaldomain.com')).toHaveLength(0);
    });

    it('does not read versions, IPs or bot addresses as contact details', () => {
      // 195 findings in this repo before the TLD was required to be alphabetic
      // — every one of them a lockfile version like `pkg@4.120.0(dep@4.2.1)`.
      expect(scanIdentifiers('f', 'version: 4.120.0(@cloudflare/workers-types@4.20260702.1)')).toHaveLength(0);
      expect(scanIdentifiers('f', '"packageManager": "pnpm@10.11.0"')).toHaveLength(0);
      expect(scanIdentifiers('f', 'Co-Authored-By: X <noreply@anthropic.com>')).toHaveLength(0);
      expect(scanIdentifiers('f', 'contact: someone@example.com')).toHaveLength(0);
      expect(scanIdentifiers('f', 'POSTGRES_HOST=192.168.1.100')).toHaveLength(0);
      expect(scanIdentifiers('f', 'listen on 127.0.0.1:3847')).toHaveLength(0);
    });

    it('masks the value it reports, because hook output gets indexed', () => {
      const [finding] = scanIdentifiers('AGENTS.md', 'Session: 104057');
      expect(finding.excerpt).not.toContain('104057');
      expect(finding.excerpt.startsWith('10')).toBe(true);
    });
  });
});
