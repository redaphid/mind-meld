Deploy mindmeld: commit, push, tag, build, pull, restart.

Steps:
1. Run `pnpm run type-check` — abort if it fails.
2. Determine the current branch (`git branch --show-current`).
3. `git fetch origin main` and `git merge origin/main` — abort if there are conflicts.
4. `git add -A && git commit` with a short message summarizing staged changes (skip if working tree is clean).
5. **If on main:**
   a. Read the version from package.json.
   b. `git push origin main`
   c. `git tag v{version} && git push origin v{version}`
   d. Monitor CI: `gh run list --limit 2 --repo redaphid/mind-meld` — poll every 15s until the "Build and Push Docker Images" run for the tag completes. Abort if it fails.
   e. Pull new images: `docker compose pull` (from this project's directory).
   f. Restart containers: `docker compose up -d`.
   g. Verify health: `curl -s http://localhost:3847/health | jq .`
6. **If on a branch:**
   a. `git push -u origin {branch}`
   b. Create a PR with `gh pr create` targeting main. Include a summary of changes.
   c. Share the PR URL with the user. Do NOT merge, tag, or restart containers.
