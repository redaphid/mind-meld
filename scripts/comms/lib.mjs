/**
 * Shared helpers for the comms-protocol scripts. Plain node, zero dependencies.
 *
 * Provider-agnostic by construction: nothing here imports or assumes a
 * specific agent runtime. The only vendor-shaped surface is that hook entry
 * points read a JSON document on stdin — a convention any runtime can produce,
 * and one these scripts tolerate the absence of (empty stdin parses to `{}`).
 *
 * Design rule (issue #75): every hook FAILS OPEN. A gh/git/network failure
 * must never brick the session — warn on stderr and behave as if there was
 * nothing to enforce.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Read the hook's stdin (runtimes pass hook input as one JSON doc). */
export const readStdinJson = () => {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    return {};
  }
};

/** Run a command, return trimmed stdout, or null on any failure. */
export const tryRun = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch {
    return null;
  }
};

/** Run gh and parse its stdout as JSON; null on failure or bad JSON. */
export const tryGhJson = (args) => {
  const out = tryRun('gh', args);
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
};

/** Current git branch name, or null (detached HEAD, not a repo, ...). */
export const currentBranch = () => {
  const branch = tryRun('git', ['branch', '--show-current']);
  return branch === null || branch === '' ? null : branch;
};

/**
 * The issue number a branch is working on, by convention a trailing
 * `-<digits>` (e.g. feat/comms-architecture-75). Null when absent.
 */
export const issueFromBranch = (branch) => {
  const match = /-(\d+)$/.exec(branch ?? '');
  return match === null ? null : Number(match[1]);
};

/** Newest ISO timestamp in a list, or null for an empty list. */
export const newest = (timestamps) => {
  const valid = timestamps.filter((t) => typeof t === 'string' && t !== '');
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (a > b ? a : b));
};

/**
 * Comments starting with an agent/coordinator marker are machine-authored;
 * everything else from the OWNER is the operator speaking.
 */
export const isAgentMarked = (body) => /^(🤖|👁|\[agent\]|\[bot\])/u.test((body ?? '').trimStart());

export const warn = (message) => {
  process.stderr.write(`comms-hook warning: ${message}\n`);
};

const STATE_PATH = '.coord-state.json';

/**
 * Persistent cycle state (high-water marks) so coordinator cycles never
 * re-read whole histories. Gitignored; local to each checkout.
 *
 * This is a CACHE, never a source of truth. `scripts/coord/` (issue #78)
 * derives coordination state from GitHub precisely so a fresh session with no
 * local files is fully current, and that property must survive: every rule in
 * the reconciler is computable from GitHub alone, and deleting this file may
 * cost an extra API call but can never change a decision.
 * Shape: { issues: { "<n>": { lastSeenCommentId } },
 *          prs: { "<n>": { lastReviewedSha } }, lastReconcileAt }
 */
export const readState = (root = '.') => {
  try {
    return JSON.parse(readFileSync(`${root}/${STATE_PATH}`, 'utf8'));
  } catch {
    return { issues: {}, prs: {} };
  }
};

export const writeState = (state, root = '.') => {
  try {
    const path = `${root}/${STATE_PATH}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    warn(`could not write ${STATE_PATH}: ${error.message}`);
  }
};
