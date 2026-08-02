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
```

`state.sh` is the interesting one. It reports the active channel and heartbeat
age, **operator messages that arrived after the coordinator's last reply**
(the unanswered inbox, computed rather than remembered), deployed vs. declared
version, open PRs, every label bucket, and unlabeled issues — which can only be
operator-authored, since agents label their own at creation.

A new coordinator reads that output and is current. No transcript archaeology.

## When to rotate

Three triggers, none of which require the operator to notice anything:

1. **Context pressure** — `.claude/hooks/coordinator-context-guard.sh` measures
   the session transcript and tells the coordinator to hand off before it
   starts dropping detail. A coordinator cannot self-assess its own decline;
   file size is at least a number. The hook is fail-open: any error exits
   silently, because a guard that can brick a session is worse than no guard.
2. **Missed heartbeat** — `.github/workflows/coordinator-deadman.yml` runs
   hourly *on GitHub*, so it keeps working in the one case that matters: the
   coordinator is wedged. Past the threshold it labels the channel
   `coordinator-stale` and posts recovery instructions, once per stall.
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
