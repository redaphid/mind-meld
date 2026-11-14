// The runner's control flow with psql and Postgres faked, so it runs everywhere
// (CI has no database). src/db/migrations.test.ts proves the same contract
// against a real server.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const psqlRuns: string[][] = []
let failOn: string | null = null

vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: (err: unknown, out?: unknown) => void) => {
    psqlRuns.push(args)
    const file = args[args.indexOf('-f') + 1]
    if (failOn && file.endsWith(failOn)) cb(Object.assign(new Error('exit 3'), { stderr: 'ERROR:  relation "x" does not exist\n' }))
    else cb(null, { stdout: '', stderr: '' })
  },
}))

vi.mock('node:fs/promises', () => ({
  readdir: async () => ['003-c.sql', 'README.md', '001-a.sql', '002-b.sql'],
}))

vi.mock('pg', () => ({
  default: {
    Client: class {
      connect = async () => {}
      end = async () => {}
      query = async (text: string) => (text.startsWith('SELECT') ? { rows: [{ filename: '001-a.sql' }] } : { rows: [] })
    },
  },
}))

const { runMigrations, applyMigration, MigrationError } = await import('./migrations.js')
const target = { host: 'h', port: 1, user: 'u', password: 'p', database: 'd' }
const fileOf = (args: string[]) => args[args.indexOf('-f') + 1].replace(/\\/g, '/').split('/').pop()

beforeEach(() => {
  psqlRuns.length = 0
  failOn = null
})

describe('runMigrations', () => {
  it('applies only unrecorded .sql files, in name order', async () => {
    expect(await runMigrations(target, '/m')).toEqual(['002-b.sql', '003-c.sql'])
    expect(psqlRuns.map(fileOf)).toEqual(['002-b.sql', '003-c.sql'])
  })

  it('stops at the first failure and names the file', async () => {
    failOn = '002-b.sql'
    const run = runMigrations(target, '/m')
    await expect(run).rejects.toBeInstanceOf(MigrationError)
    await expect(run).rejects.toThrow(/002-b\.sql[\s\S]*relation "x" does not exist/)
    expect(psqlRuns.map(fileOf)).toEqual(['002-b.sql'])
  })

  it('records a file inside the same strict, single-transaction psql run that applies it', async () => {
    await applyMigration(target, '/m', '002-b.sql')
    const [args] = psqlRuns
    expect(args).toEqual(expect.arrayContaining(['ON_ERROR_STOP=1', '--single-transaction']))
    expect(args.indexOf('-f')).toBeLessThan(args.lastIndexOf('-c'))
    expect(args[args.lastIndexOf('-c') + 1]).toBe(`INSERT INTO schema_migrations (filename) VALUES ('002-b.sql')`)
  })

  it('refuses a file name that is not a migration before running psql', async () => {
    await expect(applyMigration(target, '/m', "004-x'); DROP TABLE t; --.sql")).rejects.toThrow(/Not a migration file name/)
    expect(psqlRuns).toEqual([])
  })
})
