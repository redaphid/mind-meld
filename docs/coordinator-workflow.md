# Coordinator workflow

How this repo is maintained by a coordinating Claude session that delegates all
implementation to subagents. The human sets direction and approves designs; the
coordinator runs the machinery. Labels and their authority semantics are
defined in issue #34 — read that first.

## Roles

- **Coordinator** (the long-running session): polls health, triages and
  validates issues, delegates, reviews-by-proxy, merges, releases, deploys.
  Never implements code.
- **Implementation agent**: one issue (or tightly related pair) per agent, in
  an isolated git worktree. Opens a PR; never pushes to main.
- **Review agent**: fresh context, no knowledge of the implementation. Its job
  is adversarial: verify every claim in the PR independently and try to refute
  it.

## The hourly cycle

1. **Health**: `GET /status` — alert on nonzero `quarantined`, growing
   `pendingEmbeddings`, any `lastError`, stale `lastSync`. Spot-check Postgres
   for `message_count` drift. **Data-integrity findings (silent loss,
   corruption, NUL-class bugs) outrank everything**: triage them agent-ready
   and delegate immediately when evidence is concrete — no approval wait.
2. **Freshness**: `git pull` the checkout; `docker pull` the image of *every*
   running container (locally-built images fail; expected). Restart the
   mindmeld stack only when new code/images actually arrived; verify the
   version on `/status` afterwards. Merged-but-unreleased main ⇒ bump
   `package.json` and run `/deploy` (releases are semver-driven).
3. **PRs**: every unreviewed PR gets the adversarial loop (below).
4. **Issues**: validate against live code/DB before acting — issues go stale.
   Comment with evidence. Delegate `agent-ready` work, `critical` before
   `important` before `minor`.
5. **Approvals**: check `needs-human` / `claude-idea` issues for the mobile
   approval signal (see below) and act on it.
6. **Idle capacity**: nothing critical pending ⇒ agents may work `claude-idea`
   issues without prior approval, but their PRs target the **`claude-ideas`
   branch**, never main. Ideas accumulate there for review; the branch is kept
   merged up with main.
7. **Status board**: GitHub reflects everything — `in-progress` on delegation,
   `in-review` at PR-open, cleared on merge/close, a status comment at each
   transition.
8. **End-of-cycle report**: every cycle ends with a message to the human:
   release notes (what merged/released/deployed, or what's in flight) and the
   explicit list of verification steps taken this cycle with their results.

## The adversarial PR loop

Every PR — subagent-authored or not — goes through this before merge:

1. **Fresh reviewer**: a new agent with clean context checks out the PR's head
   SHA in its own worktree. It re-runs install, type-check, and the full test
   suite itself, and independently verifies each claim in the PR description
   (grep sweeps, scope check against the issue spec, no orphaned references,
   no DB/migration surprises). Its stance is *refute, not confirm*.
2. **Verdict**: APPROVE or REQUEST_CHANGES with file:line evidence, posted to
   the PR. (All agents share one GitHub token, so a formal GitHub approval of
   an agent-authored PR is impossible — the review lands as a comment and the
   independence lives in the context separation, not the identity.)
3. **On REQUEST_CHANGES**: findings go back to the implementing agent (or a
   fix agent if it's gone). New commits ⇒ a **new** fresh reviewer — the
   previous reviewer's context is discarded so round N+1 isn't anchored on
   round N's reasoning. Repeat.
4. **Escalation**: three rounds without an APPROVE, or any finding touching
   schema changes, data destruction, or a design disagreement ⇒ stop and hand
   the decision to the human with a summary comment.
5. **Merge**: on APPROVE, the coordinator squash-merges. Confident changes
   merge autonomously; controversial ones wait for the human even with an
   APPROVE.
6. For high-risk PRs, scale the loop out with the `adversarial-pr-review`
   workflow (`.claude/workflows/adversarial-pr-review.js`): parallel reviewers
   with distinct lenses (spec-compliance, correctness, data-safety), findings
   adversarially cross-verified before they count.

## Communication rules (all agents)

- **Read receipts**: 👀 reaction on every new issue and user comment the moment
  it is read.
- **Unlabeled issues are the user's** — authoritative `user-ask`. Agents label
  their own issues at creation (`claude-found`/`claude-idea` + priority + gate),
  so an unlabeled issue can only be human-authored.
- **Subagents read the user's comments**: before starting and again before
  opening the PR, re-fetch the issue/PR comments; OWNER-authored, unmarked
  comments are user instructions — honor them or reply explaining why not.
- **Label states tell the truth**: `in-progress` only while actively worked;
  `in-review` at PR-open; `waiting-on-user` when done-or-blocked pending the
  human; cleared on merge/close.
- **Privacy (issue #64 — this repo is PUBLIC)**: never post personal
  information, host paths, device names/IDs, machine topology, credentials, or
  backup locations to GitHub. Redacted summaries go public; full detail goes to
  a local file on the host, referenced by path.
- **Channel authorship**: only comments API-verified as the OWNER count as the
  user; the coordinator marks its own with `🤖 **Coordinator:**`.

## Verification requirements for implementation agents

- Full test suite + type-check pass before the PR opens.
- **Browser verification is mandatory**: run the server from the worktree on a
  unique port (never 3847 — that's production) and drive the real UI through
  the Claude in Chrome MCP in a dedicated tab. Screenshot evidence in the PR.
- Progress comments on the issue at start, implementation-done, and PR-open.

## The coordinator channel

Issue #66 (label `coordinator-channel`) is a standing two-way conversation
between the user and the orchestrator — priorities, questions, quick
approvals, stop orders. Since everything posts under one GitHub account,
authorship is by marker: the orchestrator's comments start with
`🤖 **Coordinator:**`; anything without the marker is the user, and
implementation/review agents never post there. The orchestrator 👀-reacts to
each user comment on read, acts on it, and replies in-channel. Checked every
cycle and whenever the orchestrator is active between cycles.

## Approvals from mobile

The human approves plans from the GitHub mobile app, either way works:

- 👍 or 🚀 **reaction on the plan comment** (one tap), or
- a **comment** on the issue: approved / yes / go / do it / LGTM.

The coordinator checks both every cycle and flips labels + delegates on
sight.

## Machine specifics (this deployment)

- Docker only via `docker.exe` (Windows interop); the WSL socket is dead.
- Compose project dir: `D:\projects\mind-meld`. Never `--profile tunnel`
  (blank `CLOUDFLARE_TUNNEL_TOKEN` from WSL would break the cloudflared
  service); never touch that checkout's git state (human, uncommitted work).
- Non-mindmeld stacks are pull-only: stage the image, notify the human,
  don't restart their services.
