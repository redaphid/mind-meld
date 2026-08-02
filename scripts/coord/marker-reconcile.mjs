#!/usr/bin/env node
// Find machine comments already on GitHub that never got an authorship marker.
//
// The hook stops new violations; this finds the ones already sitting in the
// threads, where they do real damage: an unmarked agent report reads as the
// operator speaking, so `inbox.sh` raises a false alarm and the coordinator
// burns a cycle answering itself.
//
// Fixing is opt-in and conservative. Editing someone's comment is a serious
// act, so the default is a dry run that prints every finding with the reasons
// it was flagged, and `--fix` only ever PREPENDS a marker — the original words
// are never altered, and the repair says out loud that it was retroactive.
//
//   node scripts/coord/marker-reconcile.mjs                 # dry run, exit 1 on findings
//   node scripts/coord/marker-reconcile.mjs --limit 30
//   node scripts/coord/marker-reconcile.mjs --fix
//
// Plain node, zero dependencies; it shells out to `gh` like a person would.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { classifyComment, markerFor } = await import(
  pathToFileURL(resolve(HERE, 'marker.mjs')).href
);

export const RETRO_NOTE =
  '<sub>Authorship marker added retroactively by `scripts/coord/marker-reconcile.mjs`; the text below is unchanged.</sub>';

// Signals that a body came out of a machine. Deliberately keyed on the SHAPE of
// agent writing — structured reports, gate results, cycle logs — rather than on
// topic, because the operator writes about the same topics in two short lines.
const SIGNALS = [
  [/🤖 Generated with \[Claude Code\]/i, 4, 'Claude Code footer'],
  [/Co-Authored-By:\s*Claude/i, 4, 'Claude co-author trailer'],
  [/\bcycle \d+ (green|complete)\b/i, 3, 'cycle report'],
  [/\bred\s*(→|->)\s*green\b/i, 3, 'red/green cycle language'],
  [/\btype-?check (is )?clean\b/i, 3, 'gate result: type-check'],
  [/\b\d+ tests? (pass|passing|green)\b/i, 3, 'gate result: test count'],
  [/\bready for review\b/i, 2, 'PR status update'],
  [/\bverdict\s*[:*]/i, 3, 'review verdict'],
  [/^\s*##+ /m, 1, 'markdown heading'],
  // Several sections is report-writing, not a remark. The operator's longest
  // comments are still prose; agents reach for headings almost immediately.
  [(b) => (b.match(/^\s*##+ /gm) ?? []).length >= 2, 2, 'multi-section report'],
  [/^\s*- \[[ x]\]/m, 2, 'task checklist'],
  [/```/, 1, 'fenced code block'],
  [/\bnext\s*[:\-—]/i, 1, '"next:" hand-off line'],
  [/\bS[1-4]\b\s*[—:-]/, 2, 'severity-graded review finding'],
];

const LONG_ENOUGH = 400; // characters — the operator's asks are short
const THRESHOLD = 3;

/**
 * Does this body look machine-written? Returns the evidence, not just a verdict,
 * because a `--fix` that cannot be audited should not be run.
 */
export function machineAuthorship(body) {
  if (typeof body !== 'string' || !body.trim()) return { isMachine: false, score: 0, signals: [] };
  // Already marked is not a violation, whoever wrote it.
  if (classifyComment(body).isMachine) return { isMachine: false, score: 0, signals: ['already marked'] };

  let score = 0;
  const signals = [];
  for (const [test, weight, label] of SIGNALS) {
    if (typeof test === 'function' ? test(body) : test.test(body)) {
      score += weight;
      signals.push(label);
    }
  }
  const lines = body.split('\n').filter((l) => l.trim()).length;
  if (body.length > LONG_ENOUGH && lines >= 5) {
    score += 2;
    signals.push('long structured report');
  }
  return { isMachine: score >= THRESHOLD, score, signals };
}

/** Unmarked machine comments among a thread's comments. */
export function findViolations(comments, ownerLogin) {
  return (Array.isArray(comments) ? comments : [])
    .filter((c) => c?.user?.login === ownerLogin)
    .map((c) => ({ ...c, verdict: machineAuthorship(c.body) }))
    .filter((c) => c.verdict.isMachine);
}

/**
 * The repaired body: a marker, an honest note that it was added after the fact,
 * then the original text byte for byte.
 *
 * It signs as an agent, never as the coordinator — a coordinator marker would
 * tell `lib.sh` the operator had been answered, which is the exact bug this
 * whole change exists to kill.
 */
export function repairedBody(original) {
  return `${markerFor({ role: 'agent', name: 'unattributed' })} ${RETRO_NOTE}\n\n${original}`;
}

// ---------------------------------------------------------------------------

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function main(argv) {
  const fix = argv.includes('--fix');
  const li = argv.indexOf('--limit');
  const limit = li === -1 ? 40 : Number(argv[li + 1]);
  const repo = process.env.GH_REPO || gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
  const owner = gh(['repo', 'view', repo, '--json', 'owner', '-q', '.owner.login']).trim();

  const threads = [
    ...JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', String(limit), '--json', 'number'])),
    ...JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(limit), '--json', 'number'])),
  ].map((t) => t.number);

  const seen = new Set();
  const violations = [];
  for (const n of threads) {
    if (seen.has(n)) continue;
    seen.add(n);
    let comments = [];
    try {
      comments = JSON.parse(gh(['api', `repos/${repo}/issues/${n}/comments`, '--paginate']));
    } catch {
      process.stderr.write(`marker-reconcile: could not read comments on #${n}, skipping\n`);
      continue;
    }
    for (const v of findViolations(comments, owner)) violations.push({ thread: n, ...v });
  }

  for (const v of violations) {
    const first = String(v.body).split('\n').find((l) => l.trim()) ?? '';
    process.stdout.write(
      `#${v.thread} comment ${v.id} (score ${v.verdict.score}: ${v.verdict.signals.join(', ')})\n` +
        `  ${v.html_url}\n  ${first}\n`,
    );
  }

  if (!violations.length) {
    process.stdout.write('no unmarked machine comments found\n');
    return 0;
  }

  if (!fix) {
    process.stdout.write(
      `\n[dry-run] ${violations.length} unmarked machine comment(s) — run with --fix to prepend markers\n`,
    );
    return 1;
  }

  let fixed = 0;
  for (const v of violations) {
    try {
      gh(['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${v.id}`, '-f', `body=${repairedBody(v.body)}`, '--silent']);
      fixed++;
    } catch (err) {
      process.stderr.write(`marker-reconcile: could not edit comment ${v.id}: ${err?.message}\n`);
    }
  }
  process.stdout.write(`\nmarked ${fixed}/${violations.length} comment(s)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
