# Quality ratchet

Dead code and test coverage in this repo are governed by a ratchet
(issue #43): both metrics may improve, neither may regress, and existing
debt is a **warning**, never a build failure. The mechanism is two
checked-in baselines plus two checker scripts that CI runs on every PR
(`.github/workflows/quality.yml`).

| Metric | Tool | Baseline | Checker |
| ------ | ---- | -------- | ------- |
| Dead files / exports / types / deps | [knip](https://knip.dev) (`knip.jsonc`) | `quality/knip-baseline.json` — the identity of every deferred finding | `scripts/quality/knip-ratchet.ts` |
| Test coverage | vitest + v8 (`vitest.config.ts`) | `quality/coverage-baseline.json` — floor percentages for lines / statements / functions / branches | `scripts/quality/coverage-ratchet.ts` |

## How CI decides

- **Regression → fail.** A knip finding not in the baseline, or any coverage
  percentage below its floor. Fix the code; don't touch the baseline.
- **Improvement not ratcheted → fail.** You fixed a baseline item (or raised
  coverage) but didn't tighten the baseline in the same PR. Run
  `pnpm run quality:update` and commit the changed `quality/*.json`. This is
  how CI guarantees the baselines always match reality.
- **Standing debt → warning.** Baseline items that still exist and coverage
  below 100% produce `::warning::` annotations only. The build stays green.

## Day-to-day commands

```bash
pnpm run knip              # raw knip report — see all standing findings
pnpm run test:coverage     # tests + coverage summary
pnpm run quality           # exactly what CI runs (coverage run + both checks)
pnpm run quality:update    # ratchet the baselines down/up after an improvement
```

`quality:update` is one-directional by design: it refuses to add knip items
or to lower a coverage floor. The only way to *loosen* a baseline is to edit
the JSON by hand — which shows up plainly in the PR diff and requires a
written justification there.

## What counts as cheating

The point of the ratchet is real improvement. The following satisfy the
numbers without improving anything, and get a PR rejected:

- **Deleting or skipping tests** to change what coverage measures. Coverage
  is computed over *all* of `src/` (`coverage.all` in `vitest.config.ts`),
  so this normally shows as a drop — attempts to re-scope `include`/`exclude`
  to dodge that are the same offense.
- **Knip-ignore sprawl.** Every `ignore*` entry in `knip.jsonc` must carry a
  comment explaining *why* knip cannot see the usage (e.g. invoked via npx,
  ambient types). An ignore without a justification comment is a review
  blocker. Prefer fixing or baselining over ignoring.
- **Hand-growing a baseline** (adding knip items, lowering a coverage floor)
  without an explicit justification in the PR description. The `--update`
  scripts refuse to do this precisely so a human has to own the decision in
  the diff.
- **Un-exporting instead of deleting.** Removing the `export` keyword from a
  dead symbol clears the knip finding while keeping the dead code (now
  invisible to the tool). If it's dead, delete it; if it's not, wire it up.
- **Vacuous tests** that execute code without asserting anything, purely to
  raise line coverage.

Conversely, these are *not* cheating: genuinely deleting dead code, adding
real tests, and running `quality:update` to record either.

## Scope notes

- `scripts/` is excluded from `tsconfig.json` but is real, executed code —
  `knip.jsonc` deliberately lists every script (including `scripts/test/`)
  as an entry so their dependencies stay accounted for. Don't quietly drop
  them from the knip project.
- `public/` (browser app, vendored Preact) is outside knip's TypeScript
  module graph and outside coverage; it is verified by browser checks, not
  by this ratchet.
- The initial baselines (2026-08) start at 31 knip findings and
  35.95 / 35.95 / 73.12 / 81.9 % coverage. Target: empty baseline, 100%.
