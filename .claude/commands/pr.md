Open a pull request for the current branch.

Steps:

1. **Refuse to run on main.** `git branch --show-current` — if it is `main`, stop and tell the user to branch first. Do not create a PR from main.

2. **Check it builds.** Run `npx tsc --noEmit` and `npx vitest run`. Abort and report if either fails.
   Use `npx`, not `pnpm` — pnpm is not on PATH on the Windows host.

3. **Commit anything outstanding.** If `git status --porcelain` is non-empty, show the user what is uncommitted and ask before committing it. Never sweep unrelated files into a PR.

4. **Rebase onto latest main.** `git fetch origin main` then `git rebase origin/main`.
   If there are conflicts, stop and hand them to the user — do not resolve them unattended.
   Re-run step 2 after rebasing; a clean rebase can still break the build.

5. **Push.** `git push -u origin $(git branch --show-current)` (add `--force-with-lease` if the rebase rewrote already-pushed commits — never bare `--force`).

6. **Find the issues this closes.** Search the commit messages and the diff for issue references. Also check `gh issue list --limit 30` for issues this obviously resolves. Confirm with the user before adding a `Closes #N` line — closing the wrong issue is annoying to undo.

7. **Create the PR** with `gh pr create --base main`. The body should say:
   - what changed and **why**, in prose — not a restatement of the diff
   - how it was verified (tests added, commands run, real output where it matters)
   - `Closes #N` for confirmed issues
   - anything deliberately left out, and why

   End the body with:

   ```
   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   ```

8. **Label it** using the repo's scheme (see issue #34): origin (`user-ask` / `claude-found` / `claude-idea`), priority (`critical` / `important` / `minor`). A PR fixing a labeled issue should inherit that issue's labels.

9. **Report the URL.** Do not merge — that is `/merge`.
