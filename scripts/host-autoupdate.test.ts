// Runs `host-autoupdate.sh` against a throwaway checkout and a stub
// docker. On macOS it runs under the system /bin/bash, which is 3.2 and has no
// associative arrays, next to BSD date, stat and mv: the host it must work on.
import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dirname, 'host-autoupdate.sh')
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash'

const DOCKER = `#!/bin/sh
case "$1 $2" in
  "compose ps") printf 'mcp|mindmeld-mcp-1\\nui|mindmeld-ui-1\\npostgres|mindmeld-postgres-1\\n' ;;
  "image inspect") case "$5" in *ui*) echo "\${STUB_UI_REVISION:-$STUB_REVISION}" ;; *) echo "$STUB_REVISION" ;; esac ;;
  "inspect -f") [ "$3" = "{{.Config.Image}}" ] && echo "ghcr.io/example/$4:latest" || echo "sha256:$4" ;;
esac
`

const git = (cwd: string, ...args: string[]): string =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Wobbly Lighthouse', GIT_AUTHOR_EMAIL: 'lighthouse@example.com', GIT_COMMITTER_NAME: 'Wobbly Lighthouse', GIT_COMMITTER_EMAIL: 'lighthouse@example.com' } }).stdout.trim()

describe('host-autoupdate.sh', () => {
  let checkout: string
  let stubs: string
  let commits: string[]
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'host-autoupdate-'))
    const origin = join(root, 'origin.git')
    checkout = join(root, 'checkout')
    stubs = join(root, 'bin')
    git(root, 'init', '-q', '--bare', '-b', 'main', origin)
    git(root, 'clone', '-q', origin, checkout)
    git(checkout, 'checkout', '-q', '-b', 'main')
    commits = ['commit-crooked-teapot', 'commit-sleepy-anvil'].map((message) => {
      git(checkout, 'commit', '-q', '--allow-empty', '-m', message)
      return git(checkout, 'rev-parse', 'HEAD')
    })
    git(checkout, 'push', '-q', 'origin', 'main')

    mkdirSync(stubs)
    writeFileSync(join(stubs, 'docker'), DOCKER)
    writeFileSync(join(stubs, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n')
    chmodSync(join(stubs, 'docker'), 0o755)
    chmodSync(join(stubs, 'timeout'), 0o755)
    // The script re-runs itself with `bash` from PATH; keep that the same bash.
    symlinkSync(spawnSync('sh', ['-c', `command -v ${BASH}`], { encoding: 'utf8' }).stdout.trim(), join(stubs, 'bash'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const autoupdate = (command: string, revision: string, uiRevision = revision): SpawnSyncReturns<string> =>
    spawnSync(BASH, [SCRIPT, command], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, AUTOUPDATE_REPO: checkout, STUB_REVISION: revision, STUB_UI_REVISION: uiRevision },
    })
  const status = (revision: string): SpawnSyncReturns<string> => autoupdate('status', revision)

  describe('when every image carries main', () => {
    let run: SpawnSyncReturns<string>

    beforeEach(() => {
      run = status(commits[1])
    })

    it('reports the host current', () => {
      expect(run.stdout).toContain('mindmeld on this host: CURRENT')
    })

    it('exits zero', () => {
      expect(run.status).toBe(0)
    })

    it('writes no errors', () => {
      expect(run.stderr).toBe('')
    })

    it('lists the published revision', () => {
      expect(run.stdout).toMatch(new RegExp(`published  ${commits[1].slice(0, 8)} +\\(as of`))
    })

    it('records when it checked as an ISO time', () => {
      expect(JSON.parse(readFileSync(join(checkout, '.autoupdate/status.json'), 'utf8')).checkedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    })
  })

  describe('when the images carry an older commit of main', () => {
    let run: SpawnSyncReturns<string>

    beforeEach(() => {
      run = status(commits[0])
    })

    it('reports the host behind', () => {
      expect(run.stdout).toMatch(/mindmeld on this host: BEHIND \d+m/)
    })

    it('exits nonzero', () => {
      expect(run.status).toBe(1)
    })
  })

  describe('when a run pulls images from different commits', () => {
    beforeEach(() => {
      autoupdate('run', commits[1], commits[0])
    })

    it('waits for a complete set', () => {
      expect(readFileSync(join(checkout, '.autoupdate/last-run'), 'utf8')).toMatch(/waiting: published images are from different commits \([0-9a-f]{8} [0-9a-f]{8} \)/)
    })
  })

  describe('when a run that is gone left its lock behind', () => {
    beforeEach(() => {
      mkdirSync(join(checkout, '.autoupdate/lock'), { recursive: true })
      writeFileSync(join(checkout, '.autoupdate/lock/pid'), '999999\n')
      autoupdate('run', commits[1])
    })

    it('breaks the lock and runs', () => {
      expect(readFileSync(join(checkout, '.autoupdate/autoupdate.log'), 'utf8')).toContain('broke a lock left by run 999999')
    })
  })
})
