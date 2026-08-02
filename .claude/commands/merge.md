Merge a pull request and clean up after it.

Takes an optional PR number. With no argument, uses the PR for the current branch.

Steps:

1. **Find the PR.** `gh pr view {number or current branch} --json number,title,state,mergeable,statusCheckRollup,url`.
   Stop if it is already merged or closed.

2. **Check CI.** `gh pr checks {number}`.
   - Still running: tell the user, and offer to wait and poll every 30s rather than merging blind.
   - Failing: stop. Report which check failed and why. Never merge red CI without the user explicitly saying so.

3. **Check mergeability.** If `mergeable` is `CONFLICTING`, stop — the branch needs a rebase (`/pr` does that).

4. **Show what is about to land** and confirm with the user: PR title, number of commits, files changed, and any `Closes #N` lines. Merging is hard to undo; a one-line confirmation is cheap.

5. **Merge.** `gh pr merge {number} --squash --delete-branch`.
   Squash keeps main's history one-commit-per-change, matching how this repo reads.
   Use `--merge` instead only if the user asks to preserve individual commits.

6. **Sync local.**
   ```sh
   git checkout main && git pull origin main
   ```
   If the local branch was deleted remotely, `git branch -d {branch}` locally too.

7. **Confirm what closed.** Report which issues GitHub auto-closed, and check `gh issue list` for any that should have closed but did not — a `Closes #N` in a squashed commit body does not always fire.

8. **Say what is not done yet.** A merge to main does not deploy. If the change needs to reach the running containers, point at `/release` (to cut a version) or `/deploy`.
