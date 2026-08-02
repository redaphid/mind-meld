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

/**
 * The comment's OWN voice: quoted text, fenced blocks, inline code and HTML
 * comments removed.
 *
 * Without this, the operator pasting an agent's report back to complain about
 * it scores higher than the report itself did — his words would be stamped as
 * a machine's because he quoted a machine. Evidence only counts when the
 * author is the one saying it.
 */
export function ownVoice(body) {
  return String(body ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^[ \t]*~~~[\s\S]*?(?:^[ \t]*~~~|$)/gm, ' ')
    .replace(/^[ \t]{0,3}>.*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

// Signals that a body came out of a machine.
//
// `conclusive` marks the things only a machine says about its own work: a
// generated footer, a cycle log, a gate result, a graded review verdict.
// Everything else is stylistic — it describes writing that is long and tidy,
// which the operator also produces. Stylistic evidence can REPORT a comment but
// never auto-fix it, because structure is not authorship.
//
// `raw` signals are about the shape of the document, so they are measured
// before quoted material is stripped; the rest are measured on the own voice.
const SIGNALS = [
  // `artifact` signals are emitted BY tooling, not phrases a person types, so
  // length tells us nothing extra about them — unlike the gate phrases below,
  // which the operator can plausibly use in a four-word question.
  { re: /🤖 Generated with \[Claude Code\]/i, weight: 4, label: 'Claude Code footer', conclusive: true, artifact: true },
  { re: /Co-Authored-By:\s*Claude/i, weight: 4, label: 'Claude co-author trailer', conclusive: true, artifact: true },
  { re: /\bcycle \d+ (green|complete)\b/i, weight: 3, label: 'cycle report', conclusive: true },
  { re: /\bred\s*(→|->)\s*green\b/i, weight: 3, label: 'red/green cycle language', conclusive: true },
  { re: /\btype-?check (is )?clean\b/i, weight: 3, label: 'gate result: type-check', conclusive: true },
  { re: /\b\d+ tests? (pass|passing|green)\b/i, weight: 3, label: 'gate result: test count', conclusive: true },
  { re: /\bverdict\s*[:*]/i, weight: 3, label: 'review verdict', conclusive: true },
  { re: /\bS[1-4]\b\s*[—:-]/, weight: 2, label: 'severity-graded review finding', conclusive: true },
  { re: /\bready for review\b/i, weight: 2, label: 'PR status update' },
  { re: /^\s*##+ /m, weight: 1, label: 'markdown heading', raw: true },
  // Several sections is report-writing, not a remark — but the operator writes
  // long structured comments too, so this stays stylistic.
  { test: (b) => (b.match(/^\s*##+ /gm) ?? []).length >= 2, weight: 2, label: 'multi-section report', raw: true },
  { re: /^\s*- \[[ x]\]/m, weight: 2, label: 'task checklist', raw: true },
  { re: /```/, weight: 1, label: 'fenced code block', raw: true },
  { re: /\bnext\s*[:\-—]/i, weight: 1, label: '"next:" hand-off line' },
];

const LONG_ENOUGH = 400; // characters — the operator's asks are short
const SUBSTANTIAL = 200; // characters below which nothing is ever auto-fixed
const THRESHOLD = 3;

/**
 * Does this body look machine-written? Returns the evidence, not just a verdict,
 * because a `--fix` that cannot be audited should not be run.
 *
 * `isMachine` means "worth reporting". `conclusive` means "a machine said
 * something only a machine says about its own work" — and ONLY `conclusive`
 * comments are ever edited. Stamping one of the operator's comments as
 * machine-authored would misattribute his words and teach every downstream
 * tool to ignore them, which is worse than the bug this tool exists to fix.
 */
export function machineAuthorship(body) {
  const empty = { isMachine: false, conclusive: false, score: 0, signals: [] };
  if (typeof body !== 'string' || !body.trim()) return empty;
  // Already marked is not a violation, whoever wrote it.
  if (classifyComment(body).isMachine) return { ...empty, signals: ['already marked'] };

  const voice = ownVoice(body);
  let score = 0;
  let conclusive = false;
  let artifact = false;
  const signals = [];
  for (const signal of SIGNALS) {
    const subject = signal.raw ? body : voice;
    const hit = signal.test ? signal.test(subject) : signal.re.test(subject);
    if (!hit) continue;
    score += signal.weight;
    signals.push(signal.conclusive ? `${signal.label} (conclusive)` : signal.label);
    if (signal.conclusive) conclusive = true;
    if (signal.artifact) artifact = true;
  }
  const lines = body.split('\n').filter((l) => l.trim()).length;
  if (body.length > LONG_ENOUGH && lines >= 5) {
    score += 2;
    signals.push('long structured report');
  }

  // A machine reporting on its own work is never terse. The operator asking
  // "is type-check clean?" hits a conclusive phrase in four words, so length
  // is the difference between a report and a question about a report.
  const substantial = body.length >= SUBSTANTIAL || lines >= 4 || artifact;
  if (conclusive && !substantial) {
    conclusive = false;
    signals.push('too terse to be a machine report — not auto-fixable');
  }

  return { isMachine: score >= THRESHOLD, conclusive, score, signals };
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

  // Only comments carrying machine-specific evidence may ever be edited.
  // The rest are reported for a person to read, and left alone.
  const fixable = violations.filter((v) => v.verdict.conclusive);
  const uncertain = violations.filter((v) => !v.verdict.conclusive);

  const show = (list, heading) => {
    if (!list.length) return;
    process.stdout.write(`\n${heading}\n`);
    for (const v of list) {
      const first = String(v.body).split('\n').find((l) => l.trim()) ?? '';
      process.stdout.write(
        `#${v.thread} comment ${v.id} (score ${v.verdict.score}: ${v.verdict.signals.join(', ')})\n` +
          `  ${v.html_url}\n  ${first}\n`,
      );
    }
  };
  show(fixable, '== machine-authored on its own evidence (safe to mark) ==');
  show(
    uncertain,
    '== structured, but with no machine-specific evidence — READ THESE YOURSELF, they could be the operator ==',
  );

  if (!violations.length) {
    process.stdout.write('no unmarked machine comments found\n');
    return 0;
  }

  if (!fix) {
    process.stdout.write(
      `\n[dry-run] ${violations.length} unmarked machine comment(s): ${fixable.length} markable, ` +
        `${uncertain.length} needing a human read. --fix marks only the ${fixable.length}.\n`,
    );
    return 1;
  }

  if (uncertain.length) {
    process.stderr.write(
      `marker-reconcile: leaving ${uncertain.length} comment(s) alone — structure is not authorship, ` +
        'and marking one of the operator\'s comments as a machine\'s would misattribute his words.\n',
    );
  }

  let fixed = 0;
  for (const v of fixable) {
    try {
      gh(['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${v.id}`, '-f', `body=${repairedBody(v.body)}`, '--silent']);
      fixed++;
    } catch (err) {
      process.stderr.write(`marker-reconcile: could not edit comment ${v.id}: ${err?.message}\n`);
    }
  }
  process.stdout.write(`\nmarked ${fixed}/${fixable.length} comment(s); left ${uncertain.length} untouched\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
