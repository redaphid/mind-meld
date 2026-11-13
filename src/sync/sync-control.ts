import { query } from '../db/postgres.js'
import { config } from '../config.js'

// The `sync_control` row, and the one gate every AI checkpoint asks.
//
// The AI pipeline (embedding, summarization, aggregate vectors) is not
// controllable from the UI's own process: the queue runs in the sync workers,
// the UI runs in `mcp`. They share a database and nothing else, so both
// switches are columns of one row in `sync_control` (init-db/022-sync-pause.sql,
// init-db/025-semantic-switch.sql) that workers read at their safe points.
//
// The two switches answer different questions and must stay separate:
//   - stand-down is a short DEADLINE: "give the GPU back for a while". It lapses
//     on its own, so a forgotten press costs one cycle.
//   - semantic is an on/off SWITCH: "run without the AI pipeline until I say
//     otherwise". It never lapses; that is the point of it.
// Workers do not care which one is holding them, only whether something is, so
// they call aiHold() and nothing else.

// Stand-down: "stop what you are doing and pick it up next cycle."
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
  invalidateControlCache()
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
  invalidateControlCache()
  return NOT_STANDING_DOWN
}

// The semantic switch. Off means no Ollama work of any kind -- no embedding,
// no summarization, no model checks, no query vectors -- and no vector reads
// either, while transcripts, memories and the spool keep landing in Postgres
// for full-text search. Every row still enters the queue
// (src/embeddings/pending.ts), so switching back on drains what accumulated.
export type SemanticState = {
  enabled: boolean
  changedAt: string | null
  reason: string | null
}

type SemanticRow = {
  semantic_enabled: boolean
  semantic_changed_at: Date | null
  semantic_reason: string | null
}

const summarizeSemantic = (row: SemanticRow | undefined): SemanticState => ({
  enabled: row?.semantic_enabled ?? config.semantic.enabledAtStartup,
  changedAt: row?.semantic_changed_at?.toISOString() ?? null,
  reason: row?.semantic_reason ?? null,
})

export const readSemantic = async (): Promise<SemanticState> => {
  const result = await query<SemanticRow>(
    `SELECT semantic_enabled, semantic_changed_at, semantic_reason FROM sync_control WHERE id = TRUE`
  )
  return summarizeSemantic(result.rows[0])
}

export const setSemantic = async (enabled: boolean, reason: string | null = null): Promise<SemanticState> => {
  const result = await query<SemanticRow>(
    `UPDATE sync_control
        SET semantic_enabled = $1, semantic_changed_at = now(), semantic_reason = $2
      WHERE id = TRUE
      RETURNING semantic_enabled, semantic_changed_at, semantic_reason`,
    [enabled, reason]
  )
  invalidateControlCache()
  return summarizeSemantic(result.rows[0])
}

// Why background AI work must stop right now, or null when it may run. When
// both switches hold, semantic-off wins: it is the one that will still be true
// after the stand-down deadline lapses.
export type AiHold = 'semantic-off' | 'standing-down'

type ControlState = { semanticEnabled: boolean; standingDown: boolean }

// Logged at every checkpoint that acts on a hold, so a cycle that did almost
// nothing says why in the place someone will look -- its own logs.
export const AI_HOLD_NOTICE: Record<AiHold, string> = {
  'semantic-off': 'Semantic is switched off: skipping all AI work. Queued rows wait until it is switched back on.',
  'standing-down': 'Standing down: ingestion asked to stop. Resuming at the next scheduled cycle.',
}

// Workers ask between every batch and every session, so the row is cached for
// a beat. A press then takes up to CACHE_MS longer to be noticed, against a
// checkpoint interval of seconds to minutes; a query per session would be a
// real cost paid forever.
const CACHE_MS = 2000
let cached: { at: number; state: ControlState } | null = null

// Every write drops the cache, or the process that served the press keeps
// working for another beat -- and a switch-on that kicks a drain straight away
// would see the stale "off" and drain nothing.
export const invalidateControlCache = () => {
  cached = null
}

// An unreadable row is not a switch that says stop -- the columns arrive in
// migrations applied by `mcp` on startup, so a worker can legitimately meet a
// database without them. Stand-down fails OPEN. Semantic falls back to
// MINDMELD_SEMANTIC, so a process started with it off stays off without the
// row; one started without it behaves as it did before the switch existed.
const readControl = async (): Promise<ControlState> => {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_MS) return cached.state

  let state: ControlState
  try {
    const result = await query<StandDownRow & SemanticRow>(
      `SELECT stand_down_until, stand_down_at, stand_down_reason, semantic_enabled
         FROM sync_control WHERE id = TRUE`
    )
    const row = result.rows[0]
    state = {
      semanticEnabled: summarizeSemantic(row).enabled,
      standingDown: summarizeStandDown(row, new Date()).standingDown,
    }
  } catch (e) {
    // Cached too: if the table is missing, every checkpoint would otherwise
    // pay a failing round-trip.
    state = { semanticEnabled: config.semantic.enabledAtStartup, standingDown: false }
    console.warn(
      `[sync-control] could not read sync_control, assuming semantic ${state.semanticEnabled ? 'on' : 'off'} and no stand-down: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  cached = { at: now, state }
  return state
}

// The gate for every background AI checkpoint: the sync orchestrator, the
// embedding batch loop, the per-session aggregate loop, the model checks.
export const aiHold = async (): Promise<AiHold | null> => {
  const { semanticEnabled, standingDown } = await readControl()
  if (!semanticEnabled) return 'semantic-off'
  if (standingDown) return 'standing-down'
  return null
}

// For work that only the semantic switch governs: an interactive search and
// centroid computation are not ingestion, so a stand-down does not stop them,
// but neither may touch a vector while semantic is off.
export const semanticEnabled = async (): Promise<boolean> => (await readControl()).semanticEnabled
