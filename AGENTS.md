# Agent protocol for this repository

Any automated agent working in this repo — whatever runtime it happens to be —
MUST follow the rules below. They are project policy, not vendor-specific
tooling: no script has to be installed for them to apply.

## Non-negotiable rules

1. **Privacy — the repo is public**: never post or commit personal
   information, host paths outside the repo, device names/IDs, machine
   topology, credentials, or backup locations (issue #64). This is enforced
   mechanically by `src/quality/no-personal-data.test.ts`; if it fires,
   replace the value with a placeholder rather than deleting the check.
2. **Never push to main.** Feature branch (suffix `-<issue number>`), PR,
   review. Full test suite + `pnpm run type-check` + `pnpm run quality`
   before marking a PR ready for review.
3. **Honor operator comments**: re-fetch issue and PR comments before
   starting work AND before marking a PR ready. Every comment from the repo
   owner gets honored or answered with a reason — never ignored.
4. **Truthful labels**: `in-progress` only while actively working;
   `in-review` the moment a PR is up; `waiting-on-user`/`needs-human` only
   while genuinely blocked on the owner. A label that no longer describes
   reality is worse than no label.
5. **Validate issues before acting on them.** Issues go stale. Check the
   claim against live code and the database first, and comment with the
   evidence you found.
6. **No truncation** of data returned to API consumers — see CLAUDE.md.

## Deploys are semver-driven

Merging to `main` does **not** deploy. CI only builds images when
`package.json`'s `version` changes. Bump it deliberately; see CLAUDE.md.
