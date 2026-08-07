import {
  generatePendingEmbeddings,
  updateAggregateEmbeddings,
  AGGREGATE_BATCH_SIZE,
} from '../embeddings/batch.js'
import { drainIngestSpool } from '../sync/ingest-spool.js'

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
//
// It also drains the edge ingest spool first (when INGEST_SPOOL_* is set),
// because in a containers-only deployment this service may be the only process
// that ever runs a sync pass — without this, spooled conversations would wait
// for a host-side loop that deployment doesn't have.

export type SyncRunState = {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  messagesEmbedded: number
  sessionsUpdated: number
  spoolDrained: number
  spoolQuarantined: number
  durationMs: number | null
  error: string | null
}

export type SyncRunResult = {
  messagesEmbedded: number
  sessionsUpdated: number
  spoolDrained?: number
  spoolQuarantined?: number
  error?: string
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
  spoolDrained: 0,
  spoolQuarantined: 0,
  durationMs: null,
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
  // Spool first: fast, GPU-free, and what it lands is exactly what the
  // embedding pass below should then pick up. drainIngestSpool never throws
  // for a payload — bad ones go to sync_quarantine — so errors here are
  // transport-level and reported without aborting the embedding half.
  const spool = await drainIngestSpool()

  const embedded = await generatePendingEmbeddings()

  let sessionsUpdated = 0
  const drainStart = Date.now()
  while (true) {
    const aggregate = await updateAggregateEmbeddings()
    sessionsUpdated += aggregate.sessionsUpdated
    if (aggregate.sessionsFetched < AGGREGATE_BATCH_SIZE) break
    if (Date.now() - drainStart > MAX_AGGREGATE_DRAIN_MS) {
      console.log('[sync-run] aggregate drain budget reached; backlog resumes next run')
      break
    }
  }

  return {
    messagesEmbedded: embedded.processed,
    sessionsUpdated,
    spoolDrained: spool.drained,
    spoolQuarantined: spool.quarantined,
    ...(spool.errors.length > 0 ? { error: spool.errors.join('; ') } : {}),
  }
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
    spoolDrained: 0,
    spoolQuarantined: 0,
    durationMs: null,
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
    spoolDrained: 0,
    spoolQuarantined: 0,
    durationMs: null,
    error: null,
  }
  inFlight = null
}
