// Pre-commit guard: refuse to commit personal data into this PUBLIC repo.
//
// WHAT IT SCANS, and why that choice matters
//
// Only the lines this commit ADDS — `git diff --cached`, hunk by hunk. Three
// consequences, all deliberate:
//
//   * It never runs the test suite, never opens the database, never touches
//     the network. As of 2026-08-07 `pnpm test` fails in the main checkout for
//     an unrelated reason (a tracked docker-compose file deleted in another
//     agent's working tree). A hook that shelled out to the suite would block
//     every commit in this repo today, and a guard that blocks everything is
//     `--no-verify`'d within a day and then protects nothing.
//
//   * Pre-existing violations elsewhere in a file you are editing do not block
//     you. You are answerable for what you are adding. (`docs/openapi.yaml`
//     already carries `Uber Eats` and `Kia` example queries from before this
//     hook existed — that is a real leak, and it is tracked separately rather
//     than dumped on whoever next edits that file.)
//
//   * It is one `git diff` and one pass over the added lines. Milliseconds.
//
// Detection lives in src/quality/personal-data.mjs, shared with the whole-repo
// test guard so the two cannot drift.

import { execFileSync } from 'node:child_process';
import {
  isSkipListed,
  loadTermHashes,
  scanIdentifiers,
  scanStructural,
  scanTerms,
} from '../src/quality/personal-data.mjs';

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const repoRoot = git(['rev-parse', '--show-toplevel']).trim();

/**
 * Git quotes a path containing unusual bytes even with quotepath=false. Undo
 * that, so a finding names the file the way the developer typed it.
 */
const unquotePath = (raw) => {
  if (!raw.startsWith('"')) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(1, -1);
  }
};

/**
 * The added side of the staged diff: for each file, the lines being introduced
 * and the line numbers they will land on.
 *
 * `--unified=0` means there is no context to distinguish from real additions,
 * so every `+` line is new content. Deletions produce no `+` lines and are
 * skipped for free; a binary change produces "Binary files ... differ" and no
 * hunk, so binaries are skipped for free too.
 *
 * @returns {Map<string, { line: number, text: string }[]>}
 */
const stagedAdditions = () => {
  const patch = git([
    '-c', 'core.quotepath=false',
    'diff', '--cached', '--no-color', '--no-ext-diff', '--unified=0',
    '--diff-filter=ACMR', '-M',
  ]);

  /** @type {Map<string, { line: number, text: string }[]>} */
  const byFile = new Map();
  let file = null;
  let nextLine = 0;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      file = target === '/dev/null' ? null : unquotePath(target).replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('@@')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      nextLine = hunk ? Number(hunk[1]) : 0;
      continue;
    }
    if (file === null || !raw.startsWith('+') || raw.startsWith('+++')) continue;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ line: nextLine, text: raw.slice(1) });
    nextLine += 1;
  }
  return byFile;
};

/**
 * The scanners are all per-line, so a file's added lines can be handed over as
 * one synthetic document and the reported line numbers mapped back to where
 * the content will actually live.
 */
const scanAdditions = (file, added, banned) => {
  const document = added.map((a) => a.text).join('\n');
  const findings = [
    ...scanStructural(file, document),
    ...scanIdentifiers(file, document),
    ...(banned ? scanTerms(file, document, banned) : []),
  ];
  return findings.map((f) => ({ ...f, line: added[f.line - 1]?.line ?? f.line }));
};

const main = () => {
  const additions = stagedAdditions();
  if (additions.size === 0) return 0;

  // A missing or unreadable term list must not take the other two tiers down
  // with it — a partial guard still beats none, as long as it says so.
  let banned = null;
  try {
    banned = loadTermHashes(repoRoot);
  } catch (error) {
    process.stderr.write(
      `personal-data guard: banned-term list unreadable (${error.message}).\n` +
      'Structural and quoted-content checks still ran; the term check did not.\n\n',
    );
  }

  const findings = [];
  let scanned = 0;
  for (const [file, added] of additions) {
    if (isSkipListed(file)) continue;
    scanned += 1;
    findings.push(...scanAdditions(file, added, banned));
  }

  if (findings.length === 0) {
    return 0;
  }

  // Location and rule, with the value MASKED. This output is read aloud in
  // agent transcripts and those transcripts are ingested back into mindmeld —
  // printing the value in full is how a leak gets published twice.
  const lines = [
    '',
    'BLOCKED: this commit adds personal data to a PUBLIC repository.',
    '',
    `${findings.length} finding(s) across ${scanned} staged file(s):`,
    '',
    ...findings.map((f) => `  ${f.file}:${f.line}  ${f.check}  [${f.excerpt}…]`),
    '',
    'Values are masked on purpose: this repo is public and hook output ends up',
    'in transcripts that get indexed. Open the file and line to see the value.',
    '',
    'Fix it, do not route around it:',
    '  - ids in docs        -> <SESSION_ID>, <MESSAGE_ID>',
    '  - home paths         -> /home/<user>, C:\\Users\\<user>',
    '  - machine/host names -> <machine>, mindmeld.example.com',
    '  - example queries    -> invent one; never paste a real phone record',
    '',
    '`git commit --no-verify` skips this check. It exists, it is not disabled,',
    'and using it is a deliberate act you are choosing to be accountable for —',
    'this repo is public and the history is permanent.',
    '',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
  return 1;
};

process.exit(main());
