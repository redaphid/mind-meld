# Agent protocol for this repository

Any automated agent working in this repo — Claude Code or any other tool that
reads AGENTS.md — MUST follow the communication protocol below. The full
version, with commands, lives in `.claude/skills/comms/SKILL.md`; workflow
context is in `docs/coordinator-workflow.md`. Hooks under `.claude/hooks/`
enforce parts of it; the protocol applies even where no hook checks it.

## Non-negotiable rules

1. **Read receipts**: 👀-react to every new issue and every operator comment
   the moment you read it (`gh api .../reactions -f content=eyes`).
2. **Authorship markers**: all agents post under the owner's account, so mark
   your comments — `🤖 **Coordinator:**` (coordinator) or `🤖 **Agent:**`
   (implementation/review agents). Any unmarked OWNER comment is the human
   operator and is an instruction.
3. **Honor operator comments**: re-fetch issue and PR comments before
   starting work AND before marking a PR ready. Every unmarked OWNER comment
   gets honored or answered with a reason — never ignored.
4. **Watchable work**: draft PR immediately after the first push; a PR
   progress comment at every red→green cycle (the `Stop` hook blocks ending a
   session whose open PR has pushes newer than its last comment); issue
   comments at start, done, and PR-open.
5. **Truthful labels**: `in-progress` only while actively working;
   `in-review` the moment a PR is up (flip it yourself at `gh pr create`);
   `waiting-on-user`/`needs-human` only while genuinely blocked on the
   operator. `pnpm run reconcile:labels` detects drift; `--fix` repairs it.
6. **Coordinator channel**: issue #66 is operator↔coordinator only.
   Implementation and review agents never post there.
7. **Privacy — the repo is public**: never post personal information, host
   paths outside the repo, device names/IDs, machine topology, credentials,
   or backup locations to GitHub (issue #64).
8. **Never push to main.** Feature branch (suffix `-<issue number>`), PR,
   review. Full test suite + `pnpm run type-check` + `pnpm run quality`
   before ready-for-review.
9. **Context economy**: high-water marks (last-seen comment ids, last-reviewed
   PR SHAs) live in `.claude/coordinator-state.json` (gitignored). Read it
   instead of re-reading histories; update it after acting. Use mindmeld's
   own MCP search for long-horizon recall.
