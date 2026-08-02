# Coordinator handoff protocol

A coordinator runs out of context. That is not a failure mode to be avoided —
it is a certainty to be scheduled. The v1 → v2 handoff had to be designed and
driven by hand while the outgoing coordinator was already too slow to help,
which is precisely the cost this protocol exists to remove.

## The one idea

**State lives on GitHub, not in a context window.** Labels are the state
machine, issue comments are the log, the channel is the inbox. A successor
therefore boots by *querying*, not by being *briefed* — so the outgoing
coordinator's cooperation is optional and its degradation is survivable.

Everything below follows from that.

## Ownership

Exactly one open issue carries `coordinator-active`. That issue is the channel;
whoever answers there is the coordinator. Its generation comes from its
`coordinator-vN` label, and that generation is the marker prefix on every
comment the coordinator writes (`🤖 **Coordinator v2:**`). Handing off is
therefore a label move, not a conversation.

Predecessor channels stay open and readable. They are never retired, so a
predecessor that is still limping along keeps its thread and does not get
confused by traffic meant for its successor.

## The four commands

```bash
scripts/coord/state.sh        # derive the entire board from GitHub — the bootstrap path
scripts/coord/heartbeat.sh "what this cycle did"   # end every cycle with this
scripts/coord/handoff.sh --to v3 --reason "context pressure"
scripts/coord/handoff.sh --to v3 --reason "predecessor unresponsive" --force
scripts/coord/handoff.sh --to v3 --dry-run   # rehearse it, change nothing
```

`state.sh` is the interesting one. It reports the active channel and heartbeat
age, **operator messages that arrived after the coordinator's last reply**
(the unanswered inbox, computed rather than remembered), deployed vs. declared
version, open PRs, every label bucket, and unlabeled issues — which can only be
operator-authored, since agents label their own at creation.

A new coordinator reads that output and is current. No transcript archaeology.

## Two rules that are load-bearing, and were once broken

**Only the coordinator's own marker means "answered".** Everyone posts under one
GitHub account, so the inbox cutoff is a string match — and it originally
matched any comment starting with 🤖. Implementation agents post as
`🤖 **Agent (…):**`, so a single agent status report marked every operator
directive before it as answered, and three real asks were lost. The cutoff now
matches `🤖 **Coordinator vN:**` for the channel's *own* generation and nothing
else. When a comment is ambiguous it counts as **unanswered**: a false alarm is
cheap, a dropped operator message is not. That classifier lives in one place,
`scripts/coord/comments.mjs`, and is unit tested.

**Every list states its limit.** `gh issue list` silently caps at 30. With 46
open issues, the section of `state.sh` headed "operator-authored, authoritative"
printed 8 of 14 and dropped the six oldest. All lists now pass an explicit
`COORD_LIST_LIMIT` (default 500) and print a loud `🚨 TRUNCATED` banner in-band
if they reach it. A cap is not a bug; a cap you cannot see is.

## When to rotate

Three triggers, none of which require the operator to notice anything:

1. **Context pressure** — `.claude/hooks/coordinator-context-guard.sh` measures
   the session transcript and tells the coordinator to hand off before it
   starts dropping detail. A coordinator cannot self-assess its own decline;
   file size is at least a number. The hook is fail-open: any error exits
   silently, because a guard that can brick a session is worse than no guard.

   It is **opt-in**: it does nothing unless `COORD_CONTEXT_GUARD=1` is set.
   Its registration lives in the committed `.claude/settings.json`, so without
   that gate it fires for every contributor to this public repo, telling people
   in unrelated sessions to rotate a coordinator they are not running. Set the
   variable in the coordinator's own environment, or in the gitignored
   `.claude/settings.local.json`.
2. **Missed heartbeat** — `.github/workflows/coordinator-deadman.yml` runs
   hourly *on GitHub*, so it keeps working in the one case that matters: the
   coordinator is wedged. Past the threshold it labels the channel
   `coordinator-stale` and posts recovery instructions, once per stall.

   Three states it now reports that it previously swallowed: a channel that has
   **never** recorded a heartbeat (measured from the channel's creation instead,
   so a successor that boots and immediately wedges cannot stay invisible —
   `handoff.sh` also seeds the first heartbeat so this is rare); **two** issues
   carrying `coordinator-active`; and **no** issue carrying it at all, which is
   the most severe state in the model and used to be a `::warning::` on a green
   cron run that nobody reads. It now opens a `coordinator-unowned` issue, which
   `handoff.sh` closes once coordination is owned again.
3. **Operator says so** — `handoff.sh --force`, any time, no ceremony.

## Why `--force` exists

The recovery path must not route through the thing that is broken. With
`--force`, a successor is stood up without the predecessor writing, approving,
or acknowledging anything: the state record is derived, the label moves, the
new channel opens. The old coordinator finding out later is fine.

## Cycle contract

Every cycle ends with `heartbeat.sh`, which edits one pinned comment in place
rather than posting a new one — the deadman gets its timestamp and the operator
gets no notification spam. Anything the operator must actually see is a real
comment, deliberately written.

## The coordinator is reborn hourly

A cloud routine ("Mindmeld coordinator hourly cycle", :26 past every hour) runs
a full cycle in a **fresh session with zero context**, on the bridge
environment so it can reach the live service and the checkouts.

That is the cure rather than a workaround. A coordinator that persists
accumulates context until it degrades; a coordinator that is reborn each hour
and bootstraps from `state.sh` cannot. Generations therefore rotate for
staleness, context pressure, or an operator request — never for a routine
cycle, or the board would fill with channels.

The routine self-heals before it coordinates: unowned board ⇒ stand a
coordinator up; stale heartbeat ⇒ `--force` rotate. And if the handoff scripts
themselves fail, it is instructed to fix and commit them rather than complete
the handoff by hand — a workflow that needs a human to restart it is the exact
failure this schedule exists to prevent.

## What is deliberately not automated

Judgement. The protocol moves *state*, never decisions: merges, design
approvals, and priority calls stay with the coordinator and the operator. This
machinery only guarantees that whoever holds the board can see all of it.
