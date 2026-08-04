import {
  generatePendingEmbeddings,
  updateAggregateEmbeddings,
  AGGREGATE_BATCH_SIZE,
} from '../embeddings/batch.js'

// A manually triggered ingestion pass, for the "Run ingestion now" button in
// the UI and for POST /api/sync.
//
// What this runs is the embedding half of the pipeline: the messages already in
// Postgres that have no vector in Chroma yet, plus the session/project
// aggregates built from them. It deliberately does NOT rescan transcript files
// — that half belongs to the sync workers, which are the containers holding the
// read-only transcript mounts. So this drains the backlog on demand instead of
// waiting out SYNC_INTERVAL_SECONDS, and it is the half that actually talks to
// Ollama, which makes it the useful thing to press after changing where Ollama
// lives.

export type SyncRunState = {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  messagesEmbedded: number
  sessionsUpdated: number
  durationMs: number | null
  // The run ended because ingestion was stood down, not because it ran out of
  // work. Shown rather than swallowed: a manual run that stops after eight
  // seconds should say why.
  stoodDown: boolean
  error: string | null
}

export type SyncRunResult = {
  messagesEmbedded: number
  sessionsUpdated: number
  stoodDown: boolean
}

// A button anyone can press repeatedly, driving work that takes minutes and
// holds a serialized Ollama slot. Two concurrent drains would fight over the
// same pending rows and double the load on a GPU we are explicitly trying not
// to monopolise, so a second press reports the run already in flight rather
// than starting another.
let state: SyncRunState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  messagesEmbedded: 0,
  sessionsUpdated: 0,
  durationMs: null,
  stoodDown: false,
  error: null,
}

let inFlight: Promise<void> | null = null

export const getSyncRunState = (): SyncRunState => ({ ...state })

// Aggregates are drained batch-by-batch rather than one batch per press, but a
// manual run is something a person is watching, so it stops well short of the
// 50-minute budget the scheduled sync allows itself. Whatever is left resumes
// on the next press or the next scheduled cycle.
const MAX_AGGREGATE_DRAIN_MS = 5 * 60 * 1000

const runPendingEmbeddings = async (): Promise<SyncRunResult> => {
  const embedded = await generatePendingEmbeddings()
  let stoodDown = embedded.stoodDown

  let sessionsUpdated = 0
  const drainStart = Date.now()
  while (!stoodDown) {
    const aggregate = await updateAggregateEmbeddings()
    sessionsUpdated += aggregate.sessionsUpdated
    if (aggregate.stoodDown) {
      stoodDown = true
      break
    }
    if (aggregate.sessionsFetched < AGGREGATE_BATCH_SIZE) break
    if (Date.now() - drainStart > MAX_AGGREGATE_DRAIN_MS) {
      console.log('[sync-run] aggregate drain budget reached; backlog resumes next run')
      break
    }
  }

  return { messagesEmbedded: embedded.processed, sessionsUpdated, stoodDown }
}

// Returns as soon as the run is accepted, never when it finishes: a drain takes
// minutes and the caller is an HTTP request. Progress is read back from
// getSyncRunState(). `started` false means one was already running — the state
// returned is that run's, not a new one's.
export const startSyncRun = (
  run: () => Promise<SyncRunResult> = runPendingEmbeddings
): { started: boolean; state: SyncRunState } => {
  if (state.running) return { started: false, state: getSyncRunState() }

  const startedAt = new Date()
  state = {
    running: true,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    messagesEmbedded: 0,
    sessionsUpdated: 0,
    durationMs: null,
    stoodDown: false,
    error: null,
  }

  const settle = (patch: Partial<SyncRunState>) => {
    const finishedAt = new Date()
    state = {
      ...state,
      ...patch,
      running: false,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    }
  }

  // Never rejects: an unhandled rejection here would take the whole HTTP
  // server down for a failure the caller can simply read off the state.
  inFlight = run()
    .then(result => settle(result))
    .catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[sync-run] failed:', message)
      settle({ error: message })
    })

  return { started: true, state: getSyncRunState() }
}

// Test seam: lets a test await the background run instead of polling.
export const awaitSyncRun = async (): Promise<void> => {
  await inFlight
}

export const resetSyncRunState = () => {
  state = {
    running: false,
    startedAt: null,
    finishedAt: null,
    messagesEmbedded: 0,
    sessionsUpdated: 0,
    durationMs: null,
    stoodDown: false,
    error: null,
  }
  inFlight = null
}
