Run one coordinator cycle for mindmeld. Full process: docs/coordinator-workflow.md (roles, labels per issue #34, approval channels). You coordinate; you NEVER implement code yourself — subagents in isolated worktrees do.

Steps, in order:

1. **Health**: fetch `http://localhost:3847/status` to a scratch file and read it. Alert on: nonzero `quarantined`, growing `pendingEmbeddings`, any source `lastError`, stale `lastSync`. Spot-check Postgres (localhost:5433, user mindmeld, db conversations) for `message_count` drift. Silent data-loss/corruption findings are top priority: file or update an issue with evidence and delegate immediately — no approval needed.

2. **Freshness**: `git pull --ff-only` in this checkout. Pull the image of every running container: `for img in $(docker.exe ps --format '{{.Image}}' | tr -d '\r' | sort -u); do docker.exe pull "$img" </dev/null; done` (docker only works through docker.exe Windows interop; locally-built images fail — expected). Restart the mindmeld stack only when new main code or a newer mindmeld image arrived: `docker.exe compose --project-directory 'D:\projects\mind-meld' up -d` — NEVER `--profile tunnel`, NEVER touch that checkout's git state. Verify `/status` version after. A newer non-mindmeld image: pull only, notify the user. Merged-but-unreleased main: bump `package.json` version, run `/deploy`.

3. **PRs — adversarial loop**: for each open PR not yet reviewed this round, launch a fresh-context reviewer agent (isolation: worktree) that checks out the head SHA, re-runs type-check + tests itself, independently verifies every PR claim, and tries to REFUTE. APPROVE → merge if confident (squash); controversial → leave with a comment for the user. REQUEST_CHANGES → route findings to the implementer (or a fix agent), then a NEW fresh reviewer on the next commits; after 3 rounds without approval, escalate to the user. PRs based on `claude-ideas` merge into `claude-ideas`, not main. For high-risk PRs use the `adversarial-pr-review` workflow instead of a single reviewer.

4. **Approvals**: for `needs-human`/`claude-idea` issues with a posted plan, check for the mobile approval signal — an approving comment by the repo owner (approved/yes/go/do it/LGTM) or a 👍/🚀 reaction on the plan comment (`gh api repos/{owner}/{repo}/issues/comments/{id}/reactions`). Either → flip labels, delegate.

5. **Issues**: validate against live code/DB before acting (issues go stale — comment with evidence). Delegate `agent-ready` work, critical > important > minor. Implementation agents: isolated worktree, feature branch, PR (never push main), full tests + type-check, MANDATORY browser verification via Claude in Chrome MCP against a worktree-run server on a unique port (never 3847) in their own tab, and progress comments on their issue at start / done / PR-open.

6. **Idle capacity**: nothing critical/important pending and few agents running → delegate `claude-idea` issues WITHOUT approval, but PRs target the `claude-ideas` branch (`gh pr create --base claude-ideas`). Keep `claude-ideas` merged up with main when clean.

7. **Status board**: GitHub reflects everything — `in-progress` label on delegation, `in-review` at PR-open, cleared on merge/close, status comment at every transition. Check TaskList before spawning agents to avoid duplicates.

8. **End-of-cycle report (always, in chat)**: finish every cycle with a message to the user containing (a) **release notes** — what merged/released/deployed this cycle, or "no release" with what's in flight; and (b) **verification steps taken** — the explicit list of checks run this cycle (status fields inspected, DB queries, image pulls, version confirmed after restart, test/review evidence behind any merge) and their results.

9. **Proactive updates (the user is AFK)**: do not save news for the cycle report. Post a status message in chat at every significant event — merge, release, deploy verified, review verdict, agent finished, escalation, anomaly — and send a PushNotification for milestones (deploy complete, something needs the user's decision, a failure needing attention). Every update ends with what, if anything, is waiting on the user.
