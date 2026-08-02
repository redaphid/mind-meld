#!/usr/bin/env tsx
/**
 * Coverage ratchet — coverage may rise, never fall. Target: 100%.
 *
 * Reads the json-summary produced by `pnpm run test:coverage`
 * (coverage/coverage-summary.json) and compares the four total percentages
 * against the checked-in floor in quality/coverage-baseline.json:
 *
 *   - Any metric BELOW its baseline -> regression -> exit 1. Coverage is
 *     measured over all of src (coverage.all in vitest.config.ts), so
 *     deleting tests or adding untested code shows up here.
 *   - Any metric more than STALE_MARGIN above its baseline -> improvement,
 *     but the floor must ratchet up with it -> exit 1 with instructions to
 *     run --update. CI verifies the baseline matches reality both ways.
 *   - Below 100% but at/above the floor -> a warning only. Warnings-first,
 *     per issue #43.
 *
 * --update raises the floor to current reality and REFUSES to lower it.
 * Lowering the numbers in the JSON by hand is a reviewable act that needs
 * justification in the PR. See docs/quality-ratchet.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE_PATH = resolve(ROOT, 'quality/coverage-baseline.json');
const SUMMARY_PATH = resolve(ROOT, 'coverage/coverage-summary.json');
const UPDATE = process.argv.includes('--update');

// Coverage percentages jitter slightly across V8/vitest versions; only an
// improvement bigger than this forces a baseline bump. Regressions get no
// tolerance at all.
const STALE_MARGIN = 0.25;

const METRICS = ['lines', 'statements', 'functions', 'branches'] as const;
type Metric = (typeof METRICS)[number];
type Percents = Record<Metric, number>;

const inCI = process.env.GITHUB_ACTIONS === 'true';
const warn = (msg: string) => console.log(inCI ? `::warning title=coverage ratchet::${msg}` : `WARNING: ${msg}`);
const fail = (msg: string) => console.error(inCI ? `::error title=coverage ratchet::${msg}` : `ERROR: ${msg}`);

let summaryRaw: string;
try {
  summaryRaw = readFileSync(SUMMARY_PATH, 'utf8');
} catch {
  fail(`No coverage summary at ${SUMMARY_PATH}. Run \`pnpm run test:coverage\` first.`);
  process.exit(1);
}
const totals = JSON.parse(summaryRaw).total as Record<Metric, { pct: number }>;
const current = Object.fromEntries(
  METRICS.map((m) => [m, Math.round(totals[m].pct * 100) / 100]),
) as Percents;
const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Percents;

const drops = METRICS.filter((m) => current[m] < baseline[m]);
const gains = METRICS.filter((m) => current[m] > baseline[m] + STALE_MARGIN);

if (UPDATE) {
  if (drops.length > 0) {
    fail(`--update refused: it would LOWER the floor for ${drops.map((m) => `${m} (${baseline[m]} -> ${current[m]})`).join(', ')}. The ratchet only rises. Add tests, or lower the JSON by hand with a justification in your PR.`);
    process.exit(1);
  }
  const next = Object.fromEntries(METRICS.map((m) => [m, Math.max(baseline[m], current[m])])) as Percents;
  writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n');
  console.log(`Coverage floor updated: ${METRICS.map((m) => `${m} ${baseline[m]} -> ${next[m]}`).join(', ')}.`);
  process.exit(0);
}

let failed = false;
if (drops.length > 0) {
  failed = true;
  for (const m of drops) {
    fail(`Coverage regression: ${m} ${current[m]}% is below the floor of ${baseline[m]}%. Add tests for the code you touched — the floor never moves down.`);
  }
}
if (gains.length > 0) {
  failed = true;
  fail(`Coverage improved beyond the floor (${gains.map((m) => `${m} ${baseline[m]} -> ${current[m]}`).join(', ')}) — ratchet it up so it can't slide back. Run: pnpm run quality:update  (and commit quality/coverage-baseline.json)`);
}
if (!failed) {
  const below100 = METRICS.filter((m) => current[m] < 100);
  if (below100.length > 0) {
    warn(`coverage ratchet: floor held (${METRICS.map((m) => `${m} ${current[m]}%>=${baseline[m]}%`).join(', ')}). Target is 100% — every new test raises the floor.`);
  } else {
    console.log('coverage ratchet: 100% across the board. 🎉');
  }
  console.log('coverage ratchet OK: no regression, baseline current.');
}
process.exit(failed ? 1 : 0);
