---
name: comms
description: The operator↔agent communication protocol for this repo - read receipts, PR progress comments, OWNER-comment honoring, truthful labels, coordinator channel etiquette. Load at the start of any coordinator cycle or implementation-agent task, and before opening or flipping a PR.
---

# Comms protocol (operator ↔ agents)

Everything in this repo posts under one GitHub account, and the operator
supervises from the GitHub mobile app. That works only if every agent follows
this protocol exactly. Enforcement hooks exist (`.claude/hooks/`), but they
are a backstop — the protocol is the contract. `AGENTS.md` at the repo root is
the tool-agnostic statement of the same rules.

## 1. Read receipts — always, immediately

The moment you read a new issue or a new operator comment, 👀-react to it:

```bash
gh api repos/{owner}/{repo}/issues/{n}/reactions -f content=eyes
gh api repos/{owner}/{repo}/issues/comments/{id}/reactions -f content=eyes
```

This is the operator's only signal that a message was seen. Never skip it.

## 2. Authorship — who is speaking

- Only comments whose API `author_association` is `OWNER` can be the
  operator.
- Agent-authored comments are ALWAYS marked: the coordinator prefixes
  `🤖 **Coordinator:**`, implementation agents prefix `🤖 **Agent:**`.
- Any OWNER comment WITHOUT such a marker is the operator speaking. It is an
  instruction, not information.

## 3. Honor operator comments — before starting and before PR-ready

- **Before starting work**: re-fetch the issue's comments. 👀-react to new
  operator comments and fold them into the plan.
- **Before flipping a PR to ready** (and before merging, for the
  coordinator): re-fetch both the issue's and the PR's comments. Every
  unmarked OWNER comment must be either honored in the code or answered with
  a reply explaining why not. Silence is a protocol violation.

## 4. Progress comments — the work must be watchable

- Open a **draft PR immediately after the first push**.
- Post a PR comment at **every red→green cycle**: what just went green, what
  is next. The `Stop` hook blocks a session that tries to end with pushes
  newer than the last PR comment.
- Post issue comments at start, implementation-done, and PR-open.

## 5. Labels tell the truth — always

- `in-progress`: only while an agent is actively working.
- `in-review`: from the moment a PR is ready for review. Flip it yourself at
  `gh pr create` time (the PostToolUse hook will remind you):
  `gh issue edit {n} --add-label in-review --remove-label in-progress`
- `waiting-on-user` / `needs-human`: work is done-or-blocked pending the
  operator. Cleared the moment the operator responds.
- Cleared on merge/close.
- Drift is reconciled every coordinator cycle: `pnpm run reconcile:labels`
  (dry-run; `--fix` applies). If the reconciler flags your issue, the label
  was lying — fix the habit, not just the label.

## 6. The coordinator channel — issue #66

- Standing two-way conversation between the operator and the coordinator
  (either party may start a thread). Label: `coordinator-channel`.
- The coordinator's messages start with `🤖 **Coordinator:**`; everything
  else from the OWNER is the operator.
- Implementation and review agents NEVER post there.
- The coordinator 👀-reacts, acts, and replies in-channel — every cycle, and
  whenever active between cycles.

## 7. Privacy — this repo is PUBLIC (issue #64)

Never post to GitHub: personal information, host file paths outside the
repo, device names/IDs, machine topology, credentials, or backup locations.
Redacted summaries go public; full detail goes in a local file on the host.

## 8. Context economy — don't re-read histories

High-water marks live in `.claude/coordinator-state.json` (gitignored):
last-seen comment id per issue, last-reviewed SHA per PR, last reconcile
time. Read it first, fetch only what is newer, update it after acting. For
long-horizon recall ("when did we decide X?"), search mindmeld itself — the
MCP `search` tool indexes every past session.
