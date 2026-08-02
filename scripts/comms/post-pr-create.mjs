#!/usr/bin/env node
/**
 * PostToolUse hook (matcher: Bash): after a `gh pr create`, verify the linked
 * issue was flipped to `in-review` (issue #75 — truthful labels).
 *
 * The issue number comes from the branch's trailing `-<n>` convention, or
 * from a `#<n>` reference in the command text. Exit 2 feeds the warning back
 * to Claude (non-blocking — the PR already exists); everything else exits 0.
 * FAILS OPEN on any gh/git failure.
 */
import { readStdinJson, tryGhJson, currentBranch, issueFromBranch, warn } from './lib.mjs';

const input = readStdinJson();
const command = input.tool_input?.command ?? '';
if (!/\bgh\s+pr\s+create\b/.test(command)) process.exit(0);

const fromBranch = issueFromBranch(currentBranch());
const fromCommand = /#(\d+)/.exec(command);
const issue = fromBranch ?? (fromCommand === null ? null : Number(fromCommand[1]));
if (issue === null) process.exit(0);

const data = tryGhJson(['issue', 'view', String(issue), '--json', 'labels']);
if (data === null) {
  warn(`could not verify labels on issue #${issue} after gh pr create — failing open`);
  process.exit(0);
}

const labels = (data.labels ?? []).map((l) => l.name);
if (labels.includes('in-review')) process.exit(0);

process.stderr.write(
  `Comms protocol (AGENTS.md): you just opened a PR but issue #${issue} is not labeled in-review ` +
    `(current labels: ${labels.length === 0 ? 'none' : labels.join(', ')}). ` +
    `Flip it now: gh issue edit ${issue} --add-label in-review --remove-label in-progress\n`,
);
process.exit(2);
