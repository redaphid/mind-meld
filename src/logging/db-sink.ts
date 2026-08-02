// Ships this process's console output to the shared `logs` table so /logs can
// show every machine at once. Writes are batched and fire-and-forget: logging
// must never block, slow down, or fail the work that produced the log line.

import { query } from '../db/postgres.js'
import { config } from '../config.js'
import type { LogEntry } from '../mcp/log-buffer.js'

export type PendingLog = {
  machine: string
  service: string
  level: string
  message: string
  loggedAt: Date
}

// Bounded so a database outage costs memory we can predict rather than the
// whole heap. Oldest lines go first — during an outage the recent ones matter.
const MAX_QUEUE = 5000
const FLUSH_INTERVAL_MS = 5_000
const BATCH_SIZE = 250
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

let queue: PendingLog[] = []
let dropped = 0
let written = 0
let failures = 0
let flushing = false
let timer: ReturnType<typeof setInterval> | null = null
let service = 'unknown'
let lastPruneAt = 0

// Deliberately not console.*: this module runs underneath the captured console,
// so using it here would re-enter the sink and could loop on a persistent DB
// failure. stderr is the one channel with no such feedback path.
const reportProblem = (message: string) => {
  try {
    process.stderr.write(`[log-sink] ${message}\n`)
  } catch {
    // stderr closed during shutdown — nothing useful left to do.
  }
}

export const enqueue = (entry: LogEntry) => {
  queue.push({
    machine: config.machine,
    service,
    level: entry.level,
    // Postgres text cannot hold U+0000, and one poisoned line wedges its whole
    // batch: the flush fails, retries forever, and every later log line queues
    // behind it until the cap starts dropping them. Escape visibly instead —
    // the byte is shown, not silently eaten.
    message: entry.message.replaceAll('\u0000', '\\u0000'),
    loggedAt: new Date(entry.timestamp),
  })

  if (queue.length > MAX_QUEUE) {
    dropped += queue.length - MAX_QUEUE
    queue = queue.slice(-MAX_QUEUE)
  }
}

// UNNEST keeps this to one statement and one round trip regardless of batch
// size, without hand-building a VALUES list of placeholders.
const INSERT_SQL = `
  INSERT INTO logs (machine, service, level, message, logged_at)
  SELECT * FROM UNNEST(
    $1::varchar[], $2::varchar[], $3::varchar[], $4::text[], $5::timestamptz[]
  )
`

const prune = async () => {
  const days = config.logs.retentionDays
  if (days <= 0) return

  const now = Date.now()
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now

  await query(`DELETE FROM logs WHERE logged_at < NOW() - ($1 || ' days')::interval`, [
    String(days),
  ])
}

export const flushLogs = async (): Promise<void> => {
  if (flushing || queue.length === 0) return
  flushing = true

  try {
    while (queue.length > 0) {
      const batch = queue.slice(0, BATCH_SIZE)

      try {
        await query(INSERT_SQL, [
          batch.map(b => b.machine),
          batch.map(b => b.service),
          batch.map(b => b.level),
          batch.map(b => b.message),
          batch.map(b => b.loggedAt),
        ])
      } catch (error) {
        // Leave the batch queued so the next flush retries it; the MAX_QUEUE cap
        // is what stops an unreachable database growing this without bound.
        failures++
        reportProblem(
          `flush failed (${queue.length} queued): ${error instanceof Error ? error.message : String(error)}`
        )
        return
      }

      queue = queue.slice(batch.length)
      written += batch.length
    }

    await prune()
  } catch (error) {
    reportProblem(`prune failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    flushing = false
  }
}

export const sinkStats = () => ({
  service,
  machine: config.machine,
  pending: queue.length,
  writtenSinceStart: written,
  droppedSinceStart: dropped,
  flushFailures: failures,
})

// `service` distinguishes the processes that share a machine — the Windows box
// runs both mcp and sync, and their logs would otherwise be indistinguishable.
export const startDbLogSink = (serviceName: string) => {
  service = serviceName

  if (!timer) {
    timer = setInterval(() => {
      void flushLogs()
    }, FLUSH_INTERVAL_MS)
    // Never hold the event loop open: the sync CLI is short-lived and must be
    // able to exit. beforeExit below is what gets the tail out.
    timer.unref?.()
  }

  return { write: enqueue }
}

let handlersInstalled = false
let exitFlushAttempts = 0
const MAX_EXIT_FLUSH_ATTEMPTS = 3

// One beforeExit cycle: flush if there is anything left and we have not given
// up. Exported for tests; the subtlety it guards is an infinite shutdown loop —
// a failing flush schedules async work, the loop drains, beforeExit fires
// again, forever. Seen live with a NUL-poisoned queue: the process printed its
// summary and then never exited. Bounded attempts turn that into a bounded
// delay and a visible report.
export const exitFlush = (): Promise<void> => {
  if (queue.length === 0) return Promise.resolve()
  if (exitFlushAttempts >= MAX_EXIT_FLUSH_ATTEMPTS) {
    reportProblem(
      `giving up on exit flush after ${MAX_EXIT_FLUSH_ATTEMPTS} attempts; ${queue.length} line(s) not persisted`
    )
    queue = []
    return Promise.resolve()
  }
  exitFlushAttempts++
  return flushLogs()
}

// beforeExit still allows async work, so a short-lived process (the sync CLI)
// gets its final lines persisted instead of losing them on exit.
export const installFlushOnExit = () => {
  if (handlersInstalled) return
  handlersInstalled = true

  process.on('beforeExit', () => {
    void exitFlush()
  })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void flushLogs().finally(() => process.exit(0))
    })
  }
}

// Test seam — module state is otherwise sticky across cases.
export const __resetForTests = () => {
  queue = []
  dropped = 0
  written = 0
  failures = 0
  flushing = false
  lastPruneAt = 0
  exitFlushAttempts = 0
  service = 'unknown'
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
