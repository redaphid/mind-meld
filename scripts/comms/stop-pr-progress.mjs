#!/usr/bin/env node
/**
 * Stop hook: when the current branch has an open PR, require a PR comment
 * newer than the last commit before the session stops (issue #75 — progress
 * comments at every green cycle, visible on GitHub).
 *
 * Behavior:
 * - Blocks the stop ONCE (decision:block) with instructions to post a
 *   progress comment. `stop_hook_active` guards against loops: if the session
 *   is already continuing because of this hook, it always allows the stop.
 * - FAILS OPEN: no git repo, main branch, no open PR, gh/network failure,
 *   unparseable output — all exit 0 silently or with a stderr warning.
 * - Uses the newest commit's committedDate as an approximation of "last
 *   push" (gh does not expose push timestamps).
 */
import { readStdinJson, tryGhJson, currentBranch, newest, warn } from './lib.mjs';

const input = readStdinJson();
if (input.stop_hook_active === true) process.exit(0); // loop guard

const branch = currentBranch();
if (branch === null || branch === 'main' || branch === 'master') process.exit(0);

const pr = tryGhJson(['pr', 'view', branch, '--json', 'number,comments,commits']);
if (pr === null) {
  // No PR for this branch, or gh unavailable — nothing to enforce.
  if (branch.match(/^(feat|fix|chore|docs|refactor|test)\//)) {
    warn(`could not check PR progress comments for branch ${branch} (no PR yet, or gh failed) — failing open`);
  }
  process.exit(0);
}

const lastCommit = newest((pr.commits ?? []).map((c) => c.committedDate));
const lastComment = newest((pr.comments ?? []).map((c) => c.createdAt));

if (lastCommit === null) process.exit(0);
if (lastComment !== null && lastComment >= lastCommit) process.exit(0);

process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason:
      `PR #${pr.number} has no progress comment newer than its last push. ` +
      `The comms protocol (AGENTS.md) requires a PR progress comment at every green cycle: ` +
      `post one now with \`gh pr comment ${pr.number} --body "..."\` describing what just went green and what is next, ` +
      `then stop. If you already posted one and this is stale data, just stop again.`,
  }),
);
process.exit(0);
