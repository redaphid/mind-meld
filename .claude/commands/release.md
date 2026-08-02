Cut a release: bump the version, tag it, and let CI build the images.

Takes an optional bump type (`patch`, `minor`, `major`) or an explicit version.

Steps:

1. **Must be on main, and clean.**
   ```sh
   git branch --show-current      # must be main
   git status --porcelain         # must be empty
   git pull origin main
   ```
   Stop if any of these fail. Releasing from a branch or a dirty tree produces a tag nobody can reproduce.

2. **Check it builds.** `npx tsc --noEmit` and `npx vitest run`. Abort on failure.
   Use `npx`, not `pnpm` — pnpm is not on PATH on the Windows host.

3. **Decide the version.** Read the current one from `package.json`. If the user did not say which bump, look at what landed since the last tag:

   ```sh
   git log --oneline $(git describe --tags --abbrev=0)..HEAD
   ```

   - `major` — a breaking change to the MCP tools, the HTTP API, or the database schema
   - `minor` — new capability, backward compatible
   - `patch` — fixes and internals only

   **Propose the version and the reasoning, and wait for confirmation.** Do not bump silently.

4. **Check for unapplied migrations.** If `init-db/` gained files since the last tag, say so explicitly — the sync container does not run migrations at startup (issue #23), so a release carrying a schema change needs `scripts/mm migrate` run against each database before the new image starts writing.

5. **Bump and commit.** Edit the `version` field in `package.json`. Commit with the bare version as the message, matching this repo's history:

   ```sh
   git commit -am "1.9.0"
   ```

   No prefix, no body — `git log` shows `1.8.0`, `1.9.0` and so on as release markers.

6. **Tag and push.**
   ```sh
   git push origin main
   git tag v{version}
   git push origin v{version}
   ```

7. **Watch CI.** `gh run list --limit 3 --repo redaphid/mind-meld`, poll every 30s until the image build for the tag finishes. Report failure with the failing step; do not pretend a release succeeded when the images never built.

8. **Report.** Give the version, the tag URL, and what changed since the previous tag. Deploying the new images to this host is `/deploy` — a release does not restart anything by itself.
