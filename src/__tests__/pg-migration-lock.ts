// 011-statement-timeout.sql runs ALTER ROLE, which is cluster-wide: two test
// files migrating their own fresh databases at once fail it with "tuple
// concurrently updated". Test files run in parallel, so every test that
// applies the real chain takes this lock first. Advisory locks are scoped to
// one database, so the lock always lives on `postgres`.
import pg from 'pg'

const LOCK_KEY = 11_011

export const withMigrationLock = async <T>(
  server: { host: string; port: number; user: string; password: string },
  work: () => Promise<T>
): Promise<T> => {
  const lock = new pg.Client({ ...server, database: 'postgres' })
  await lock.connect()
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    return await work()
  } finally {
    await lock.end()
  }
}
