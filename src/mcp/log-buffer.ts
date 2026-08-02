// In-memory ring buffer of this process's console output, so /api/logs can
// answer "is the server actually doing anything?" without shell access to the
// host. Only covers THIS container (mindmeld-mcp) — the sync containers are
// separate processes and log to their own stdout.

export type LogLevel = 'log' | 'warn' | 'error'

export type LogEntry = {
  seq: number
  timestamp: string
  level: LogLevel
  message: string
}

// ~2k entries is a few MB at typical line lengths and covers hours of a mostly
// idle server, while staying bounded on a chatty one.
const MAX_ENTRIES = 2000

const buffer: LogEntry[] = []
let captured = 0
let installed = false

const render = (arg: unknown): string => {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`
  if (arg === undefined) return 'undefined'
  try {
    return JSON.stringify(arg)
  } catch {
    // Circular or otherwise unserialisable — String() still beats dropping it.
    return String(arg)
  }
}

// Somewhere to forward each entry beyond this process — in production the
// Postgres `logs` table, so other machines can read it.
export type LogSink = {
  write: (entry: LogEntry) => void
}

// Patches console so every log is recorded, forwarded to the sink, and still
// written to stdout — `docker logs` must keep working exactly as before.
export const captureConsole = (sink?: LogSink) => {
  if (installed) return
  installed = true

  const levels: LogLevel[] = ['log', 'warn', 'error']
  for (const level of levels) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      const entry: LogEntry = {
        seq: captured++,
        timestamp: new Date().toISOString(),
        level,
        message: args.map(render).join(' '),
      }
      buffer.push(entry)
      if (buffer.length > MAX_ENTRIES) buffer.shift()

      // A broken sink must never take down the thing that was logging.
      try {
        sink?.write(entry)
      } catch {
        // Swallowed on purpose: reporting it here would re-enter this wrapper.
      }

      original(...args)
    }
  }
}

export type ReadLogsOptions = {
  limit: number
  offset: number
  level?: LogLevel
}

export type ReadLogsResult = {
  entries: LogEntry[]
  returned: number
  matching: number
  retained: number
  capturedSinceStart: number
  droppedSinceStart: number
  capacity: number
  limit: number
  offset: number
}

// Newest-first, paginated. Messages are never truncated — callers that hit a
// large log page should walk it with offset rather than expect a clipped tail.
export const readLogs = ({ limit, offset, level }: ReadLogsOptions): ReadLogsResult => {
  const matches = level ? buffer.filter(e => e.level === level) : buffer
  const newestFirst = matches.slice().reverse()
  const entries = newestFirst.slice(offset, offset + limit)

  return {
    entries,
    returned: entries.length,
    matching: matches.length,
    retained: buffer.length,
    capturedSinceStart: captured,
    droppedSinceStart: captured - buffer.length,
    capacity: MAX_ENTRIES,
    limit,
    offset,
  }
}
