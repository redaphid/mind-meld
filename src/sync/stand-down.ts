import { query } from '../db/postgres.js'

// "Stop what you are doing and pick it up next cycle."
//
// The ingestion pass is the heaviest thing this machine does, and it is not
// interruptible from the UI's own process: the queue runs in the sync workers,
// the UI runs in `mcp`. They share a database and nothing else, so the switch is
// a row in `sync_control` (init-db/022-sync-pause.sql) that workers read at
// their safe points.
//
// It is a short deadline, not a pause flag, and that is the whole design. A
// worker stands down only while the deadline is in the future, so:
//   - the pass in flight stops at its next checkpoint,
//   - a cycle about to start skips instead of starting,
//   - the next scheduled cycle -- an hour out, far past the window -- runs
//     normally without anyone having to remember to switch anything back on.
// The worst case of a forgotten press or a worker killed mid-pass is one lost
// cycle. It cannot freeze the index.

export type StandDownState = {
  // True only while the deadline is still ahead. Every consumer reads this
  // rather than comparing timestamps itself.
  standingDown: boolean
  until: string | null
  since: string | null
  reason: string | null
  // Floor of 0. The UI counts this down instead of re-deriving it from `until`
  // against a client clock that may not agree with the server's.
  secondsRemaining: number
}

export type StandDownRow = {
  stand_down_until: Date | null
  stand_down_at: Date | null
  stand_down_reason: string | null
}

const NOT_STANDING_DOWN: StandDownState = {
  standingDown: false,
  until: null,
  since: null,
  reason: null,
  secondsRemaining: 0,
}

// Long enough to stop the pass in flight and to catch a cycle seconds from
// starting; short enough that the next hourly cycle is never in question.
export const DEFAULT_STAND_DOWN_MINUTES = 15

// The ceiling is what keeps this from quietly becoming an off switch. Someone
// who wants the index down for a day should stop the container, which is
// visible, rather than leave a dashboard button holding it down invisibly.
export const MAX_STAND_DOWN_MINUTES = 240

export const clampMinutes = (minutes: unknown): number => {
  const n = typeof minutes === 'number' ? minutes : parseFloat(String(minutes ?? ''))
  if (!Number.isFinite(n)) return DEFAULT_STAND_DOWN_MINUTES
  return Math.min(MAX_STAND_DOWN_MINUTES, Math.max(1, Math.round(n)))
}

export const summarizeStandDown = (row: StandDownRow | undefined, now: Date): StandDownState => {
  const until = row?.stand_down_until ?? null
  if (!until) return NOT_STANDING_DOWN

  const remainingMs = until.getTime() - now.getTime()
  if (remainingMs <= 0) return NOT_STANDING_DOWN

  return {
    standingDown: true,
    until: until.toISOString(),
    since: row?.stand_down_at?.toISOString() ?? null,
    reason: row?.stand_down_reason ?? null,
    secondsRemaining: Math.ceil(remainingMs / 1000),
  }
}

const readRow = async (): Promise<StandDownRow | undefined> => {
  const result = await query<StandDownRow>(
    `SELECT stand_down_until, stand_down_at, stand_down_reason FROM sync_control WHERE id = TRUE`
  )
  return result.rows[0]
}

export const readStandDown = async (): Promise<StandDownState> =>
  summarizeStandDown(await readRow(), new Date())

// `now()` is Postgres's, not this process's: the workers, the UI and the
// database run in different containers whose clocks are only approximately
// friends, and every reader compares against the same server clock.
export const standDown = async (
  minutes: number = DEFAULT_STAND_DOWN_MINUTES,
  reason: string | null = null
): Promise<StandDownState> => {
  const result = await query<StandDownRow>(
    `UPDATE sync_control
        SET stand_down_until = now() + ($1 || ' minutes')::interval,
            stand_down_at = now(),
            stand_down_reason = $2
      WHERE id = TRUE
      RETURNING stand_down_until, stand_down_at, stand_down_reason`,
    [String(clampMinutes(minutes)), reason]
  )
  invalidateStandDownCache()
  return summarizeStandDown(result.rows[0], new Date())
}

// Clearing the deadline rather than letting it lapse: "I finished playing, get
// back to work" should not cost the rest of the window.
export const resumeSync = async (): Promise<StandDownState> => {
  await query(
    `UPDATE sync_control
        SET stand_down_until = NULL, stand_down_at = NULL, stand_down_reason = NULL
      WHERE id = TRUE`
  )
  invalidateStandDownCache()
  return NOT_STANDING_DOWN
}

// Workers ask this between every batch and every session, so it is cached for a
// beat. The cost of the cache is that a press takes up to CACHE_MS longer to be
// noticed, against a checkpoint interval measured in seconds to minutes -- and
// a stand-down that arrives 2 seconds late is indistinguishable from one that
// arrives on time, while a query per session is a real cost paid forever.
const CACHE_MS = 2000
let cached: { at: number; state: StandDownState } | null = null

export const invalidateStandDownCache = () => {
  cached = null
}

// Whether a worker's checkpoint should stop.
//
// Fails OPEN, deliberately. This table arrives in a migration, and migrations
// are applied by the `mcp` service on startup -- a sync worker can legitimately
// meet a database that has not got it yet, and a switch that cannot be read is
// not a switch that says stop. Refusing to index because the pause button is
// unreadable would be a far worse failure than ignoring a press.
export const shouldStandDown = async (): Promise<boolean> => {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_MS) return cached.state.standingDown

  try {
    const state = await readStandDown()
    cached = { at: now, state }
    return state.standingDown
  } catch (e) {
    // Cached as "no" too: if the table is missing, every checkpoint would
    // otherwise pay a failing round-trip.
    cached = { at: now, state: NOT_STANDING_DOWN }
    console.warn(
      `[stand-down] could not read sync_control, continuing: ${e instanceof Error ? e.message : String(e)}`
    )
    return false
  }
}

// Logged at every checkpoint that acts on it, so a cycle that did almost
// nothing says why in the place someone will look -- its own logs.
export const STAND_DOWN_NOTICE =
  'Standing down: ingestion asked to stop. Resuming at the next scheduled cycle.'
