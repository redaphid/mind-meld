#!/usr/bin/env tsx
/**
 * Knip ratchet — dead code is allowed to shrink, never to grow.
 *
 * The baseline (quality/knip-baseline.json) is the checked-in list of every
 * knip finding we have consciously deferred. This script runs knip and diffs
 * reality against that list, by item identity (not just count):
 *
 *   - A finding NOT in the baseline  -> regression -> exit 1.
 *   - A baseline entry knip no longer reports -> improvement, but the baseline
 *     is now stale -> exit 1 with instructions to run --update. This keeps the
 *     baseline honest: CI verifies it matches reality in both directions.
 *   - Remaining baseline debt -> a warning (GitHub annotation in CI), never a
 *     failure. Warnings-first, per issue #43.
 *
 * --update rewrites the baseline from the current knip output, but REFUSES to
 * add new items. The ratchet only turns one way; if you genuinely must
 * baseline a new finding, edit the JSON by hand and justify it in the PR.
 * See docs/quality-ratchet.md for what counts as cheating.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE_PATH = resolve(ROOT, 'quality/knip-baseline.json');
const UPDATE = process.argv.includes('--update');

// One stable string per finding, e.g. "exports:src/db/chroma.ts:getPool".
type Baseline = { items: string[] };

// Knip 6 JSON reporter: { issues: [{ file, <category>: [{ name, ... }] }] }.
// Every category (files, dependencies, exports, types, duplicates, ...) is an
// array of named entries (duplicates: array of arrays).
interface KnipIssueEntry { name: string }
type KnipFileIssues = { file: string } & Record<string, Array<KnipIssueEntry | KnipIssueEntry[]>>;
interface KnipReport { issues: KnipFileIssues[] }

const runKnip = (): KnipReport => {
  // --no-exit-code: knip's own pass/fail is irrelevant; the baseline decides.
  // shell on Windows: pnpm is a .cmd there, and execFileSync does not apply
  // PATHEXT resolution, so a bare 'pnpm' is ENOENT without it.
  const out = execFileSync('pnpm', ['exec', 'knip', '--reporter', 'json', '--no-exit-code'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  return JSON.parse(out) as KnipReport;
};

const flatten = (report: KnipReport): string[] => {
  const items: string[] = [];
  for (const issue of report.issues) {
    for (const [kind, entries] of Object.entries(issue)) {
      if (!Array.isArray(entries)) continue; // skips the `file` key
      for (const entry of entries) {
        const name = Array.isArray(entry) ? entry.map((e) => e.name).join('|') : entry.name;
        items.push(`${kind}:${issue.file}:${name}`);
      }
    }
  }
  return items.sort();
};

const inCI = process.env.GITHUB_ACTIONS === 'true';
const warn = (msg: string) => console.log(inCI ? `::warning title=quality ratchet::${msg}` : `WARNING: ${msg}`);
const fail = (msg: string) => console.error(inCI ? `::error title=quality ratchet::${msg}` : `ERROR: ${msg}`);

const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const current = flatten(runKnip());

const baselineSet = new Set(baseline.items);
const currentSet = new Set(current);
const regressions = current.filter((i) => !baselineSet.has(i));
const resolved = baseline.items.filter((i) => !currentSet.has(i));

if (UPDATE) {
  if (regressions.length > 0) {
    fail(`--update refused: ${regressions.length} NEW knip finding(s) would be added to the baseline. The ratchet only shrinks. Fix these, or baseline them by hand with a justification in your PR:`);
    for (const item of regressions) console.error(`  + ${item}`);
    process.exit(1);
  }
  writeFileSync(BASELINE_PATH, JSON.stringify({ items: current }, null, 2) + '\n');
  console.log(`Baseline updated: ${baseline.items.length} -> ${current.length} item(s) (${resolved.length} resolved).`);
  process.exit(0);
}

let failed = false;
if (regressions.length > 0) {
  failed = true;
  fail(`${regressions.length} new knip finding(s) not in the baseline (new dead code / unused deps). Fix them — do not add them to the baseline without justification:`);
  for (const item of regressions) console.error(`  + ${item}`);
}
if (resolved.length > 0) {
  failed = true;
  fail(`${resolved.length} baseline item(s) are fixed but still listed — the ratchet must tighten. Run: pnpm run quality:update  (and commit quality/knip-baseline.json)`);
  for (const item of resolved) console.error(`  - ${item}`);
}
if (!failed) {
  if (current.length > 0) {
    warn(`knip ratchet: ${current.length} known finding(s) remain in the baseline (quality/knip-baseline.json). No regression. Pay some debt down: pnpm run knip`);
  } else {
    console.log('knip ratchet: baseline is empty and knip is clean. 🎉');
  }
  console.log(`knip ratchet OK: ${current.length} known finding(s), 0 new, 0 stale.`);
}
process.exit(failed ? 1 : 0);
