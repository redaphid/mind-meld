# Who wrote this comment

Everyone — the operator, the coordinator, and every subagent — comments on
GitHub under the **same account**. `user.login` therefore tells you nothing.
The marker at the start of a comment is the only signal that separates machine
comments from the operator's, which makes it load-bearing rather than
decorative.

## The markers

```
🤖 **Agent (Mira):**        an implementation/review agent, named
🤖 **Coordinator v2:**      the coordinator of generation v2
```

An agent **names itself** — a short human first name, announced in its first
comment and used in every comment after (#79). The name is how the operator
refers to that agent later, and how two agents on the same thread stay
distinguishable.

The marker goes at the **start of the body**. Leading blank lines and HTML
comments are fine; a marker that appears only inside a quote, inside a code
fence, or further down the comment does not count — otherwise quoting an agent
would launder authorship.

## Why the distinction between agent and coordinator matters

Only a **coordinator** marker means *the operator has been answered*. An agent
posting progress must never make a question the operator is waiting on look
answered. Before this was enforced, `scripts/coord/lib.sh` counted any body
starting with 🤖 as a coordinator reply, and a sweep found **12 genuine
operator messages buried** that way — including the operator's own correction
on PR #77.

## How it is enforced

Everything is plain node under `scripts/coord/`, callable by any agent runtime,
CI job, or shell. Nothing about it is specific to one vendor's tooling.

| Tool | What it does |
| --- | --- |
| `scripts/coord/marker.mjs` | The one definition. Library + CLI: `classify`, `check`, `marker`, `unanswered`, `annotate`. |
| `scripts/coord/hooks/gh-comment-guard.mjs` | Blocks a `gh` comment/review whose body has no valid marker. Exit 0 allow, exit 2 block. |
| `scripts/coord/comment.mjs` | The easy correct path: prepends your marker for you. |
| `scripts/coord/marker-reconcile.mjs` | Finds unmarked machine comments already on GitHub; `--fix` prepends markers. |

`scripts/coord/lib.sh` and any inbox tooling call `marker.mjs` rather than
matching emoji themselves. That is the point: the grammar lived in two places
that disagreed (`/^\s*(🤖|🔎|⏱️)/` vs `startswith("🤖")`), and neither could
see past the `<!-- coord-heartbeat -->` that opens every heartbeat body — so
the coordinator's own heartbeat came back as an unanswered operator message.

### Posting

```bash
export COORD_AGENT_NAME=Mira          # once, at the start of your session
node scripts/coord/comment.mjs --pr 90 --body "cycle 2 green: ..."
```

Or write the marker yourself and post with `gh` as usual. Either way the guard
checks it.

### Wiring the guard into a runtime

Any runtime that can run a command before a shell call can enforce this:

```bash
node scripts/coord/hooks/gh-comment-guard.mjs --command "$THE_COMMAND"
# exit 0 = allow, exit 2 = block (reason on stderr)
```

Claude Code's adapter is three lines of `PreToolUse` config in
`.claude/settings.json` that point at that script. The `.claude/` directory
holds the pointer only — no logic, no policy, no documentation.

### What it will and will not catch

It **blocks**; it never rewrites. Silently editing an agent's words is worse
than making it fix them, and a rewritten body hides that a violation happened.

It fails **closed** when it cannot read the body (a shell variable, a piped
stdin) — an unreadable body is exactly how unmarked comments escape — and
**open** on any internal error of its own, because a guard that can wedge a
session is worse than no guard.

It is a guardrail, not a sandbox: a comment posted from inside `bash -c` or
some unrelated wrapper is not inspected. It catches the mistake, not the
determined evasion.

## Fixing history

```bash
pnpm run marker:reconcile          # dry run: what is unmarked, and why
pnpm run marker:reconcile --fix    # prepend markers, originals untouched
```

Findings print the signals that produced them, because a `--fix` nobody can
audit should not be run. Repairs only ever *prepend*, they say out loud that
the marker was added retroactively, and they sign as an agent — never as the
coordinator, since that would re-bury the very messages this exists to surface.
