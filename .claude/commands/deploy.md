Deploy mindmeld: commit, push, tag, build, pull, restart.

Steps:
1. Run `pnpm run type-check` — abort if it fails.
2. Read the version from package.json.
3. `git add -A && git commit` with a short message summarizing staged changes.
4. `git push origin main`
5. `git tag v{version} && git push origin v{version}`
6. Monitor CI: `gh run list --limit 2 --repo redaphid/mind-meld` — poll every 15s until the "Build and Push Docker Images" run for the tag completes. Abort if it fails.
7. Pull new images: `docker compose pull` (from this project's directory).
8. Restart containers: `docker compose up -d`.
9. Verify health: `curl -s http://localhost:3847/health | jq .`
