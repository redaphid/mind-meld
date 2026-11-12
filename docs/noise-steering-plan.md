# Noise steering repair plan

Reporting a session as useless is meant to teach search what noise looks like, so that unreported look-alikes rank lower by default. Today it barely does. The damping lands on every result almost evenly, most hits are never scored, and the noise corpus is a second store that drifts from the tags and the automated flag it copies.

This program makes the penalty reach every hit, derives the noise corpus from the two facts that already mark noise, and calibrates the damping from data instead of a fixed number. Search users get fewer monitoring runs and briefs in default results. Maintainers inherit one definition of noise and a rerunnable eval that gates every change to it.

The rule the program enforces is that a change to noise ranking ships only with an eval run showing held-out noise damped and real sessions spared. PRs in order are NS-1, NS-2, NS-3, NS-4.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skills/poteto-mode/playbooks/autopilot-stack.md` under the installed plugin. The operator lands every PR. All four PRs stop at merge-ready. The operator's standing rule forbids rebases and force pushes, so every branch update in this program is a merge commit and every stack child is cut from its parent's merged tip.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] On the operator's go, write the program objective into the standing orders and your todolist with this exact text. "Execute docs/noise-steering-plan.md. PRs NS-1, NS-2, NS-3, NS-4 in that order. Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. The operator lands every PR. Done when all four are merged, deployed, and the NS-4 eval run meets its thresholds on the live index."
- [ ] Read these from the installed plugin at program start. Re-read them at every tick.
  - [ ] `skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `skills/swarm/SKILL.md`
  - [ ] The Claude Code built-in `run` skill
  - [ ] `skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `skills/principle-build-the-lever/SKILL.md`
  - [ ] `skills/principle-subtract-before-you-add/SKILL.md`
  - [ ] `skills/principle-redesign-from-first-principles/SKILL.md`
  - [ ] `skills/principle-sequence-verifiable-units/SKILL.md`
- [ ] Arm the 30-minute audit tick as a real cadence. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from the installed plugin and the standing orders. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a lane only on affirmative failure evidence, and dispatch its replacement in the same tick. Then send the operator a status message, whether or not anything changed, with the queue table of PR, owner, state, and head SHA, the verdicts since the last tick, what merged, open operator gates, and blockers."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or rebase its branch onto the parent's exact tip when the execution playbook stacks. A same-repository child PR targets its parent branch. A fork child PR targets trunk while retaining local parent ancestry. Freeze the bottom-to-top order because fork PR bases do not encode it. In this program the operator's rule replaces every rebase with a merge of the parent tip into the child.
  - [ ] NS-1 is first. It branches from `main`.
  - [ ] NS-2 after NS-1.
  - [ ] NS-3 after NS-2.
  - [ ] NS-4 after NS-3.
- [ ] Hold the file boundaries. NS-1 touches only `scripts/noise-eval.ts`, `scripts/noise-eval.test.ts`, and `package.json`. NS-2 touches only `src/mcp/noise.ts`, `src/mcp/noise.test.ts`, `src/mcp/tools.ts`, `src/mcp/tools.test.ts`, `src/config.ts`, and `CLAUDE.md`. NS-3 touches only `src/mcp/search.ts` and its tests. NS-4 touches only `src/mcp/noise.ts`, `src/config.ts`, their tests, and `CLAUDE.md`.
- [ ] Hold the review gate. No PR in this program changes an interaction. None is review-gated.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Record the intended PR base repository as canonical `<base-repo>` and validate it through the active forge. Do not infer it from the checkout's default remote. Capture it as a shell variable and pass `--repo "$base_repo"` to every `gh pr` command. Resolve and validate `<head-url>` through Shipping step 1 and capture it as `head_url` for the live-lane fetch. When the head repository is a fork, validate its identity and record its owner and repository name as `<fork-owner>` and `<head-name>`. Never require `gt`.
- [ ] Open the PR before self-proof and follow the readiness rule in `skills/poteto-mode/playbooks/opening-a-pr.md`. Open it ready by default. When repository instructions require a draft until named evidence exists, keep it draft until that evidence is recorded. Use `origin pr create --status open --base "$base_branch"` or `gh pr create --base "$base_branch" --repo "$base_repo"` for a ready same-repository PR. A same-repository stack child targets its parent branch. Every fork PR targets trunk. With GitHub, capture the approved PR title and body as `<title>` and `<body>`, then create it with `gh api --method POST "repos/$base_repo/pulls" -f "title=$title" -f "body=$body" -f "head=$fork_owner:$branch" -f "head_repo=$head_name" -f "base=$trunk" --jq .html_url`; add `-F draft=true` when repository instructions require a draft. Otherwise use the resolved Origin command. Stacked fork branches retain local parent ancestry.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on. In this repo that is `pnpm install` followed by `pnpm run quality`.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `skills/poteto-mode/references/bugbot-triage.md` under the installed plugin.
- [ ] Before babysit, rebase each independent PR and stack root onto current trunk. Rebase each unmerged stack child onto its parent's exact tip. After its parent merges, use Shipping's explicit old-base-to-trunk rebase before the child's merge-ready report. Under the operator's rule each of these rebases is a merge commit instead, made with `gh pr update-branch` or `git merge`, and never a force push.

### Verdict and merge, for every PR

- [ ] At the merge-ready head SHA, run the swarm per `skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. One audit lane that reads the diff and the receipts and distrusts the PR body.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner. A new head gets a fresh swarm and a fresh verdict.
- [ ] A clean verdict appends the PR to the frozen bottom-to-top stack at its verdict SHA. The operator lands the bottom PR through `skills/poteto-mode/playbooks/shipping.md`. When a parent lands, the child merges the new trunk in, and its verdict stands only when `git patch-id` of its recorded-patch-base-to-head diff is unchanged at the current landing SHA.

### Boot recipe, for every live lane

Each live lane is one `swarm workers` lane at the PR head, resolved through provider dispatch, in its own worktree or output directory, with its own receipt. Drive the surface only through the driver skill this plan names.

- [ ] `git fetch -- "$head_url" "refs/heads/$head_branch" && git checkout --detach "$head_sha"` in the lane's worktree.
- [ ] Run `pnpm install`, then start the HTTP server from the worktree with `MCP_PORT=3947 POSTGRES_HOST=localhost CHROMA_HOST=localhost pnpm exec tsx --env-file=.env src/mcp/http-server.ts` against the shared Postgres on 5433 and Chroma on 8001, so the lane never restarts the deployed `mindmeld-mcp` on 3847. Wait until `curl -sf localhost:3947/health` exits 0.
- [ ] Deliver input only through the `run` skill, as `curl` against `localhost:3947/api/search` and JSON-RPC calls to `localhost:3947/mcp`. Read-only diagnostics are `docker exec mindmeld-postgres psql` selects and Chroma `count` and `get` calls. A lane that must write tags does so only on the ten sessions it names, and reverts them with `unreportUselessSession` before it returns.
- [ ] Save every screenshot to `$SCRATCH/swarm-ns<n>/worker-<lane>/<slug>.png` as a capture of the terminal output, and return the paths with the receipt path.

## Build the noise eval harness and record the baseline (NS-1)

**Depends on.** None.

**Files.**

- [ ] Create `scripts/noise-eval.ts`.
- [ ] Create `scripts/noise-eval.test.ts`.
- [ ] Edit `package.json` to add `"noise:eval": "tsx scripts/noise-eval.ts"`.

**Build.**

- [ ] `scripts/noise-eval.ts` builds clusters with the exported `sphericalKMeans`, `chooseClusterCount`, and `noiseDamping` from `src/mcp/noise.ts`, so the eval measures the code search runs and not a copy of it.
  - [ ] Noise set. Every session in the current corpus, split into five folds. Each fold is scored against clusters built from the other four, so noise is always held out.
  - [ ] Real set. A deterministic sample of 500 summarized, interactive, untagged `claude_code` sessions ordered by `md5(id)`, plus a fixed hard-negative list of real sessions about the Slack and Henchman tooling that sit near the noise.
  - [ ] Output. One JSON line with the AUC of nearest-cluster similarity, the share of real sessions damped, mean damping for each set, the share of held-out noise above the floor, and per-session damping for the hard negatives.
- [ ] Commit the baseline JSON from the live index into the PR body, not into the repo, because this repository is public and the hard-negative list is session ids only.

**You see.**

- [ ] `pnpm run noise:eval` prints one JSON line whose `real.dampedShare` is near 1.0 and whose `auc` is near 0.90, matching the prototype in Appendix A.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/noise-eval.test.ts` gains a synthetic case with two separable vector blobs, asserting AUC above 0.99, and a case with identical blobs, asserting AUC within 0.05 of 0.5. Run `pnpm exec vitest run scripts/noise-eval.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` role at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no eval harness, so record that and run the head harness against the live index. Save `baseline.png`. Pass when the JSON line parses and `real.n` is 500.
- [ ] Lane 2. Run the harness twice in a row. Save `determinism.png`. Pass when both JSON lines are byte-identical.
- [ ] Lane 3. Point the harness at an empty noise corpus with `NOISE_EVAL_CORPUS=empty`. Save `empty-corpus.png`. Pass when it prints every damping as 1 and exits 0.
- [ ] Lane 4. Stop Chroma reachability by pointing `CHROMA_PORT` at a closed port. Save `chroma-down.png`. Pass when it exits nonzero with the connection error on stderr.
- [ ] Lane 5. Compare the harness numbers with the prototype in Appendix A. Save `prototype-parity.png`. Pass when AUC and real damped share agree within 0.02.
- [ ] Lane 6. Run with `MINDMELD_NOISE_SIMILARITY_FLOOR=0.77`. Save `floor-override.png`. Pass when `real.dampedShare` falls below 0.10.
- [ ] Lane 7. Run with `MINDMELD_NOISE_PENALTY_WEIGHT=0`. Save `weight-zero.png`. Pass when every damping is 1.
- [ ] Lane 8. Grep the diff for session titles, home paths, and hostnames. Save `public-repo.png`. Pass when `pnpm exec vitest run src/quality/no-personal-data.test.ts` passes.
- [ ] Lane 9. Run the harness while a search is in flight on `localhost:3947`. Save `concurrent.png`. Pass when both complete and the search result count is unchanged.
- [ ] Lane 10. Read the harness output field names against this plan's NS-4 rule. Save `fields.png`. Pass when every field NS-4 gates on is present.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of one `pnpm run noise:eval`. Trunk lacks the harness, so the diff-added work is the whole run and the user-visible end state is the printed JSON line.
- [ ] Probe. `time pnpm run noise:eval` three times at the head. Trunk records not-applicable.
- [ ] Baseline. Record the trunk value first. Trunk lacks the harness, so the trunk value is the recorded fact that the script does not exist there.
- [ ] Rule. Absolute budget of 120 seconds per run. A run over 120 seconds fails.

**Review gate.** None. NS-1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] After the verdict, an owner merge uses Shipping step 4 to move the PR from its recorded patch base onto current trunk. An appended stack child keeps its recorded parent tip until that parent lands. Record the current landing SHA. Preserve the verdict only when the patch ID stays unchanged.
- [ ] The root appends NS-1 to the frozen bottom-to-top stack and the operator lands it. Same-repository child PRs target their parent branch.

## Derive the noise corpus from the automated flag and the useless tag (NS-2)

**Depends on.** NS-1.

**Files.**

- [ ] Edit `src/mcp/noise.ts`.
- [ ] Edit `src/mcp/noise.test.ts`.
- [ ] Edit `src/mcp/tools.ts`.
- [ ] Edit `src/mcp/tools.test.ts`.
- [ ] Edit `src/config.ts`.
- [ ] Edit `CLAUDE.md`.

**Build.**

- [ ] Delete `recordNoiseVector`, `forgetNoiseVector`, `resolveNoiseVector`, `noiseTextFor`, and the `noise` entry in `config.chroma.collections`. `reportUselessSession` writes the tag and calls `invalidateNoiseClusters`. `unreportUselessSession` removes the tag and calls `invalidateNoiseClusters`.
- [ ] `getNoiseClusters` selects `id FROM sessions WHERE deleted_at IS NULL AND (is_automated OR EXISTS (SELECT 1 FROM tags WHERE tags.session_id = sessions.id AND tag = 'useless'))`, fetches `session-<id>` vectors from `convo-sessions` in batches, and clusters those. The corpus is now a query over the two facts that already mean noise, so no second store can drift from them.
- [ ] After deploy, run the NS-1 lever in reverse on the bulk tags written on 2026-09-23. The script calls `unreportUselessSession` for every tag whose `note` is the bulk-report reason, because `is_automated` now carries those sessions into the corpus and the tags only stop `includeAutomated` from reaching them.
- [ ] After deploy, run `pnpm tsx scripts/backfill-automated.ts` once to flag the 42 persona-prompt sessions synced before #145.
- [ ] After deploy, drop the `convo-noise` Chroma collection.

**You see.**

- [ ] `reportUselessSession` on a summarized session returns its flagged message, and the next `pnpm run noise:eval` counts one more corpus vector with no write to Chroma.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/mcp/noise.test.ts` gains a case where an automated session and a tagged session both enter the corpus and an untagged interactive session does not, and a case where removing the tag removes the vector on the next build. Run `pnpm exec vitest run src/mcp/noise.test.ts src/mcp/tools.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` role at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `pnpm run noise:eval` at trunk and head. Save `eval-trunk-head.png`. Pass when head AUC is at least trunk AUC.
- [ ] Lane 2. Report one summarized interactive session and read the corpus size from the eval. Save `report-grows.png`. Pass when the corpus grows by exactly one.
- [ ] Lane 3. Unreport the same session. Save `unreport-shrinks.png`. Pass when the corpus returns to its prior size.
- [ ] Lane 4. Report a session that has no `convo-sessions` vector. Save `no-vector.png`. Pass when it is tagged and hidden and the corpus size is unchanged.
- [ ] Lane 5. Flip one session to `is_automated = true` in a transaction that is rolled back after the read. Save `automated-joins.png`. Pass when the cluster build inside the transaction counts it.
- [ ] Lane 6. Search `Slack brief question pending` with default params. Save `default-search.png`. Pass when no result is tagged useless or flagged automated.
- [ ] Lane 7. Search the same query with `includeNoise=true`. Save `include-noise.png`. Pass when the result order equals trunk's order for the same flag.
- [ ] Lane 8. Grep the head for `convo-noise` and `recordNoiseVector`. Save `no-residue.png`. Pass when neither appears outside the changelog.
- [ ] Lane 9. Call `reportUselessSession` with an unknown id. Save `unknown-id.png`. Pass when it returns `not found` and writes nothing.
- [ ] Lane 10. Read `CLAUDE.md` and the tool descriptions for the old two-store wording. Save `docs.png`. Pass when both describe the derived corpus and nothing mentions a separate noise collection.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Cold `getNoiseClusters` build time, the first search after a cache invalidation.
- [ ] Probe. Call `/api/search?mode=text&q=henchman` right after a report at trunk and at head, interleaved, five times each, reading the build time from a timing line the head and trunk both log at debug level.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Head median over 1.2 times the trunk median fails.

**Review gate.** None. NS-2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] After the verdict, an owner merge uses Shipping step 4 to move the PR from its recorded patch base onto current trunk. An appended stack child keeps its recorded parent tip until that parent lands. Record the current landing SHA. Preserve the verdict only when the patch ID stays unchanged.
- [ ] The root appends NS-2 above NS-1 in the frozen stack and the operator lands it after NS-1. NS-2 targets the NS-1 branch.

## Score every search hit by its session summary vector (NS-3)

**Depends on.** NS-2.

**Files.**

- [ ] Edit `src/mcp/search.ts`.
- [ ] Edit `src/mcp/search.test.ts`.

**Build.**

- [ ] Delete `Hit.vector` and the per-arm vector plumbing in `src/mcp/search.ts`.
- [ ] After fusion, fetch `session-<id>` vectors from `convo-sessions` for every hit in one batched `get`, and pass each to `noiseDamping`. Every hit, including full-text-only hits, is now scored in the same space the NS-2 corpus is built in.

**You see.**

- [ ] The default search `Slack brief question pending` returns the three unflagged Slack Brief sessions with scores lower than their `includeNoise=true` scores, where today their scores are identical.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/mcp/search.test.ts` gains a case where a full-text-only hit whose session vector sits on a noise cluster is damped, and a case where a hit with no session vector keeps its fused score. Run `pnpm exec vitest run src/mcp/search.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` role at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `Slack brief question pending` at trunk and head with default params and with `includeNoise=true`. Save `leak-demoted.png`. Pass when head damps at least 10 of the top 15 hits and trunk damps at most 3.
- [ ] Lane 2. Run `mode=text` for `henchman offline notifier`. Save `text-mode.png`. Pass when hits carry damping even though no vector arm ran.
- [ ] Lane 3. Search a known real topic, `coverage ratchet baseline`, from this repo's cwd. Save `real-topic.png`. Pass when the top three session ids match trunk.
- [ ] Lane 4. Search from the cwd of a hard-negative session's project. Save `project-boost.png`. Pass when that session keeps its trunk rank.
- [ ] Lane 5. Search with `includeNoise=true`. Save `switch-off.png`. Pass when the order equals trunk with the same flag.
- [ ] Lane 6. Search a query whose hits include an unsummarized session with `includeUnsummarized=true`. Save `no-session-vector.png`. Pass when that hit is returned undamped.
- [ ] Lane 7. Call the MCP `search` tool through `/mcp` with the lane 1 query. Save `mcp-parity.png`. Pass when its order equals the REST order.
- [ ] Lane 8. Search with `limit=100`. Save `wide-limit.png`. Pass when every hit carries a score and none is missing.
- [ ] Lane 9. Stop Chroma reachability for the session-vector fetch only. Save `fetch-fails-open.png`. Pass when search returns undamped results and logs the failure once.
- [ ] Lane 10. Run `pnpm run noise:eval`. Save `eval.png`. Pass when AUC is at least the NS-2 value.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Server-side latency of `/api/search?mode=text`, which isolates the new vector fetch from Ollama gate waits.
- [ ] Probe. Ten interleaved trunk and head requests for three fixed queries, timed with `curl -w '%{time_total}'`.
- [ ] Baseline. Record the trunk median per query first.
- [ ] Rule. A head median more than 150 ms above the trunk median for any query fails.

**Review gate.** None. NS-3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] After the verdict, an owner merge uses Shipping step 4 to move the PR from its recorded patch base onto current trunk. An appended stack child keeps its recorded parent tip until that parent lands. Record the current landing SHA. Preserve the verdict only when the patch ID stays unchanged.
- [ ] The root appends NS-3 above NS-2 in the frozen stack and the operator lands it after NS-2. NS-3 targets the NS-2 branch.

## Calibrate the similarity floor from real sessions (NS-4)

**Depends on.** NS-3.

**Files.**

- [ ] Edit `src/mcp/noise.ts`.
- [ ] Edit `src/mcp/noise.test.ts`.
- [ ] Edit `src/config.ts`.
- [ ] Edit `CLAUDE.md`.

**Build.**

- [ ] Replace `noise.similarityFloor` with `noise.floorQuantile`, default 0.95. When `getNoiseClusters` rebuilds, it also scores the NS-1 background sample of real sessions against the new clusters and caches the floor at that quantile beside the centroids.
- [ ] Settle the ramp's top end with the NS-1 harness before merge. The candidates are the current ramp to similarity 1.0 and a ramp that reaches full weight at the median held-out noise similarity. Keep the one with higher held-out noise damping at equal real collateral.

**You see.**

- [ ] `pnpm run noise:eval` prints `real.dampedShare` at or under 0.05 and held-out noise above the floor at or over 0.70.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/mcp/noise.test.ts` gains a case where the floor tracks the background distribution when the corpus changes, and a case where an empty background leaves every damping at 1. Run `pnpm exec vitest run src/mcp/noise.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` role at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `pnpm run noise:eval` at trunk and head. Save `eval-gate.png`. Pass when head `real.dampedShare` is at or under 0.05 and head held-out noise above floor is at or over 0.70.
- [ ] Lane 2. Rerun lane 1 of NS-3 at head. Save `leak-still-demoted.png`. Pass when all three unflagged Slack Brief sessions still rank below their `includeNoise=true` ranks.
- [ ] Lane 3. Search `coverage ratchet baseline`. Save `real-untouched.png`. Pass when none of the top five hits is damped.
- [ ] Lane 4. Report ten more automated-looking sessions, then rerun the eval. Save `floor-moves.png`. Pass when the cached floor changes after the cache window and the gate still holds.
- [ ] Lane 5. Set `MINDMELD_NOISE_FLOOR_QUANTILE=0.99`. Save `quantile-override.png`. Pass when `real.dampedShare` is at or under 0.01.
- [ ] Lane 6. Empty the background sample with a filter that matches nothing. Save `empty-background.png`. Pass when search runs undamped and logs the reason once.
- [ ] Lane 7. Search each hard-negative topic from its own project cwd. Save `hard-negatives.png`. Pass when each keeps its trunk rank.
- [ ] Lane 8. Search with `includeNoise=true`. Save `switch-off.png`. Pass when the order equals trunk with the same flag.
- [ ] Lane 9. Read `CLAUDE.md` and `src/config.ts` for the old fixed-floor rationale. Save `docs.png`. Pass when both describe the quantile and cite the eval command.
- [ ] Lane 10. Call the MCP `search` tool with the lane 2 query. Save `mcp-parity.png`. Pass when its order equals the REST order.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Cold `getNoiseClusters` build time including the background scoring.
- [ ] Probe. The NS-2 probe, interleaved at trunk and head, five times each.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Head median over 1.5 times the trunk median fails, because the build now scores 500 extra vectors once per cache window.

**Review gate.** None. NS-4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] After the verdict, an owner merge uses Shipping step 4 to move the PR from its recorded patch base onto current trunk. An appended stack child keeps its recorded parent tip until that parent lands. Record the current landing SHA. Preserve the verdict only when the patch ID stays unchanged.
- [ ] The root appends NS-4 above NS-3 in the frozen stack and the operator lands it after NS-3. NS-4 targets the NS-3 branch.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

All numbers below were measured on 2026-09-23 against the local index, after 1,917 automated sessions were bulk-reported. The prototype script lived in the session scratchpad and was not committed. NS-1 turns it into the committed harness.

The feature's intent comes from PR #136. Reporting one session should demote the unreported sessions that look like it, reversibly, by damping results at ranking time rather than moving the query, without evicting real conversations.

The penalty lands almost evenly on everything. Against the current corpus of 1,910 vectors in 32 clusters, 500 of 500 sampled real sessions were damped, by a mean factor of 0.894. Held-out noise was damped by a mean factor of 0.830. The fixed floor of 0.55 was tuned on a 120-vector corpus, and real sessions now have a median nearest-cluster similarity of 0.688.

The signal to separate them exists. Nearest-cluster similarity ranks held-out noise above real sessions with an AUC of 0.899 on the current corpus. Built from the same sessions' summary vectors instead of their `centroid_vector`, the AUC is 0.962. With the floor at the 95th percentile of real sessions, 0.771, 10 of 13 held-out noise sessions sit above it.

Most hits are never scored. In the live search `Slack brief question pending` after the bulk report, 12 of the top 15 hits had exactly their pre-report scores, because they arrived through full text and carry no vector. Five of the six unflagged Slack Brief sessions in that result do have a `convo-sessions` vector, so NS-3 reaches them.

The automated classifier works on new sessions. Persona-prompt sessions started since 2026-09-21 are all flagged. 42 older ones are not, because they were synced before #145 and the backfill has not run since. The backfill query selects each of them.

What stays unproven. The held-out noise set had only 13 sessions with summary vectors. Hit-level damping was measured with session vectors only, so NS-3's effect on rank order is predicted, not observed. The ramp's top end is open until NS-4 runs it through the harness.

## Appendix B. Alternatives rejected

Keep the separate `convo-noise` store and have the classifier write to it. This lost because every writer to it duplicates a fact Postgres already holds, and the undo path already had to guard against the two drifting.

Subtract a noise vector from the query, Rocchio style. PR #136 measured this and found it retrieves an unrelated neighbourhood. That finding still holds.

Lower the fixed floor by hand to about 0.77. It would fix today's numbers and drift again as the corpus grows, which is how the 0.55 default went stale.

Keep scoring each hit by the vector that matched it. Message and chunk vectors sit in a different distribution from session summaries, and full-text hits have no vector at all, so the penalty would keep missing most results.

Report every automated session as useless going forward. The tag duplicates `is_automated`, and it stops `includeAutomated=true` from reaching those sessions unless `includeNoise=true` is also set.

## Appendix C. Risks

Hard negatives in NS-3 and NS-4. Real sessions about the Slack monitors and Henchman sit as close to the noise as the noise does. The best one measured at similarity 0.817, the noise median. No vector method separates them, and the project boost is what protects them in their own project. Owners watch the hard-negative lines in every eval run.

New automated sessions in NS-2. They are no longer summarized or embedded, so they add nothing to the corpus. The 1,592 existing summary vectors already model those personas, and the sessions that leak into search are exactly the unflagged ones, which are summarized. Owners watch the corpus size in the eval for unexpected shrinkage.

Data operations in NS-2. Removing the bulk tags and dropping `convo-noise` happen after deploy. Removing the tags is reversible by rerunning the report lever. Dropping the collection is not, but the collection holds nothing the derived corpus does not rebuild. Owners run both only after the NS-2 live lanes pass on the deployed image.

Public repository in NS-1. The harness and its baseline must carry no titles, paths, or hostnames. The `no-personal-data` quality test is the gate.

Driver coverage. The surface is an HTTP API and a CLI, so every lane uses the `run` skill and saves terminal captures rather than UI screenshots.

## Appendix D. Links and reading list

Read `CLAUDE.md` sections on search, pending, and shared definitions before editing. Read PR #136 for the feature's original reasoning and PR #145 for the classifier. NS-2 and NS-3 get `skills/how/SKILL.md` before editing and `skills/interrogate/SKILL.md` before merge, because they change what search returns by default. Every owner keeps a trail per `skills/show-me-your-work/SKILL.md` and returns it uncommitted.
