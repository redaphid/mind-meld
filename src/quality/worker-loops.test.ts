// The sync and centroid images run their work in a shell loop with a sleep
// between passes. When the sleep was chained behind the work with `&&`, a
// failing pass skipped it and the loop ran the next pass at once, as fast as
// the process could exit, while `docker ps` still showed the container Up.
//
// This runs each image's real CMD under sh with the work replaced by a command
// that fails, and again by one that succeeds, and `sleep` replaced by a function
// that ends the run. Exactly one pass must happen before the first sleep.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '../..')

// The command each loop runs once per pass.
const WORKERS = {
  'Dockerfile.sync': '/app/mindmeld sync',
  'Dockerfile.centroids': 'pnpm compute:centroids',
}

const shellCmd = (dockerfile: string): string => {
  const lines = readFileSync(join(ROOT, dockerfile), 'utf8').split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith('CMD '))
  const cmd: string[] = []
  for (const line of lines.slice(start)) {
    cmd.push(line.replace(/\\$/, ''))
    if (!line.endsWith('\\')) break
  }
  return cmd.join('\n').replace(/^CMD /, '')
}

const hasSh = spawnSync('sh', ['-c', 'true']).status === 0

describe.skipIf(!hasSh)('worker loops sleep after every pass', () => {
  for (const [dockerfile, work] of Object.entries(WORKERS)) for (const [outcome, status] of [['fails', 1], ['succeeds', 0]] as const) {
    it(`${dockerfile} sleeps before running again when a pass ${outcome}`, () => {
      const cmd = shellCmd(dockerfile)
      expect(cmd).toContain(work)

      const script = [
        'passes=0',
        `run_pass() { passes=$((passes + 1)); echo "pass $passes"; return ${status}; }`,
        'sleep() { echo "slept after $passes pass(es)"; exit 0; }',
        cmd.replace(work, 'run_pass'),
      ].join('\n')
      const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: 5000 })

      expect(run.error).toBeUndefined()
      expect(run.stdout).toContain('slept after 1 pass(es)')
    })
  }
})
