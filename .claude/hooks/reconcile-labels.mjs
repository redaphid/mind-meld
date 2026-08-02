#!/usr/bin/env node
/**
 * Label reconciler (issue #75): finds issues whose workflow labels contradict
 * reality and prints (default) or fixes (--fix) them, so what GitHub shows is
 * always current. Run by the coordinator every cycle; also standalone via
 * `pnpm run reconcile:labels`.
 *
 * Rules:
 *   1. `needs-human` but the last comment is an unmarked OWNER response
 *      -> the operator already answered: remove `needs-human`.
 *   2. `in-progress` but no open PR references the issue and it has been
 *      quiet longer than RECONCILE_STALE_HOURS (default 4) -> remove
 *      `in-progress` (the agent is gone; the label is lying).
 *   3. `in-review` but no open PR references the issue -> remove `in-review`.
 *   4. `in-progress` but a ready (non-draft) PR references the issue
 *      -> flip to `in-review`.
 *
 * A PR "references" issue N when its body carries a closing keyword for #N
 * (closes/fixes/resolves/implements) or its head branch ends in -N; a bare
 * prose "#N" mention does not count. Exit codes: 0 clean/fixed/fail-open, 1 drift found in dry-run.
 * Writes high-water marks to .claude/coordinator-state.json (gitignored) so
 * coordinator cycles never re-read whole comment histories.
 */
import { tryGhJson, tryRun, isAgentMarked, warn, readState, writeState } from './lib.mjs';

const FIX = process.argv.includes('--fix');
const STALE_HOURS = Number(process.env.RECONCILE_STALE_HOURS ?? 4);

const issues = tryGhJson(['issue', 'list', '--state', 'open', '--json', 'number,title,labels,updatedAt', '--limit', '200']);
const prs = tryGhJson(['pr', 'list', '--state', 'open', '--json', 'number,headRefName,body,isDraft,updatedAt', '--limit', '200']);
if (issues === null || prs === null) {
  warn('could not list issues/PRs from gh — failing open, nothing reconciled');
  process.exit(0);
}

// A PR references issue N only via a closing/implementing keyword or its
// branch's -N suffix. A bare "#N" prose mention does NOT count — PRs cite
// unrelated issues all the time.
const prsReferencing = (issueNumber) =>
  prs.filter(
    (pr) =>
      new RegExp(`\\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?|implements?)\\s+#${issueNumber}\\b`, 'i').test(pr.body ?? '') ||
      new RegExp(`-${issueNumber}$`).test(pr.headRefName ?? ''),
  );

const state = readState();
state.issues ??= {};
state.prs ??= {};

/** @type {Array<{issue: number, problem: string, add: string[], remove: string[]}>} */
const drifts = [];

for (const issue of issues) {
  const labels = issue.labels.map((l) => l.name);
  const referencing = prsReferencing(issue.number);

  if (labels.includes('needs-human')) {
    const detail = tryGhJson(['issue', 'view', String(issue.number), '--json', 'comments']);
    if (detail === null) {
      warn(`could not fetch comments for issue #${issue.number} — skipping its needs-human check`);
    } else {
      const comments = detail.comments ?? [];
      const last = comments[comments.length - 1];
      if (last !== undefined) {
        state.issues[issue.number] = { ...state.issues[issue.number], lastSeenCommentId: last.id };
      }
      if (last !== undefined && last.authorAssociation === 'OWNER' && !isAgentMarked(last.body)) {
        drifts.push({
          issue: issue.number,
          problem: 'labeled needs-human but the operator already responded (last comment is an unmarked OWNER comment)',
          add: [],
          remove: ['needs-human'],
        });
      }
    }
  }

  if (labels.includes('in-progress')) {
    const readyPr = referencing.find((pr) => pr.isDraft === false);
    const quietMs = Date.now() - Date.parse(issue.updatedAt);
    if (readyPr !== undefined) {
      drifts.push({
        issue: issue.number,
        problem: `labeled in-progress but PR #${readyPr.number} is ready for review`,
        add: ['in-review'],
        remove: ['in-progress'],
      });
    } else if (referencing.length === 0 && quietMs > STALE_HOURS * 60 * 60 * 1000) {
      drifts.push({
        issue: issue.number,
        problem: `labeled in-progress but has no open PR and no activity for ${Math.floor(quietMs / 3_600_000)}h`,
        add: [],
        remove: ['in-progress'],
      });
    }
  }

  if (labels.includes('in-review') && referencing.length === 0) {
    drifts.push({
      issue: issue.number,
      problem: 'labeled in-review but no open PR references it',
      add: [],
      remove: ['in-review'],
    });
  }
}

state.lastReconcileAt = new Date().toISOString();
writeState(state);

if (drifts.length === 0) {
  console.log(`no drift: ${issues.length} open issues match reality`);
  process.exit(0);
}

for (const drift of drifts) {
  const actions = [...drift.remove.map((l) => `remove ${l}`), ...drift.add.map((l) => `add ${l}`)].join(', ');
  console.log(`issue #${drift.issue}: ${drift.problem} -> ${actions}`);
  if (FIX) {
    const args = ['issue', 'edit', String(drift.issue)];
    for (const label of drift.remove) args.push('--remove-label', label);
    for (const label of drift.add) args.push('--add-label', label);
    if (tryRun('gh', args) === null) warn(`gh ${args.join(' ')} failed — label left as-is`);
  }
}

console.log(FIX ? `fixed ${drifts.length} drift(s)` : `[dry-run] ${drifts.length} drift(s) found — run with --fix to apply`);
process.exit(FIX ? 0 : 1);
