// The dead-letter store for sync. Anything the pipeline cannot parse or insert
// lands here whole, so a failure costs one record and stays replayable instead
// of vanishing with the source file.
//
// Two rules make it a store of last resort rather than one more thing that can
// break:
//
//  1. Payloads are base64. Nothing about a record's bytes can make the INSERT
//     that quarantines it fail the way the original insert did.
//  2. Quarantining never throws. If even this write fails, it is logged and
//     sync carries on — losing the copy is bad, losing the rest of the session
//     because the copy failed would be worse.

import { query } from '../db/postgres.js'
import { config } from '../config.js'
import { parseClaudeLine, type ParsedMessage } from '../parsers/claude-messages.js'
import { queries } from '../db/postgres.js'
import { normalizeText } from '../utils/text-encoding.js'
import { IngestPayloadSchema } from '../mcp/ingest-schema.js'

// Rows from the edge ingest spool (src/sync/ingest-spool.ts) hold a whole
// IngestPayload conversation, not a Claude transcript line, and replay must
// dispatch on that or it would feed JSON conversations to parseClaudeLine.
export const SPOOL_QUARANTINE_SOURCE = 'ingest_spool'

export type QuarantineStage = 'parse' | 'insert'

export type QuarantineInput = {
  source: string
  filePath: string
  // Identifies the record within its file: the line number for a parse failure,
  // the message uuid for an insert failure.
  recordKey: string
  lineNumber?: number
  sessionExternalId?: string
  sessionId?: number
  projectId?: number
  stage: QuarantineStage
  // The record exactly as it was when it failed: the source line for 'parse',
  // the parsed message for 'insert'.
  payload: string
  error: unknown
}

// The error string is derived from the record's bytes — V8's JSON.parse quotes
// a snippet of the failing input in e.message, raw NULs included — so it must
// be normalized like any other text column. Without this, the very bytes that
// broke the original insert break the INSERT that preserves them, which is
// exactly what rule 1 above promises cannot happen.
const message = (error: unknown) =>
  normalizeText(error instanceof Error ? error.message : String(error))

export const encodePayload = (payload: string) => Buffer.from(payload, 'utf8').toString('base64')

export const decodePayload = (payload: string) => Buffer.from(payload, 'base64').toString('utf8')

// A run of NUL bytes is not a damaged record, it is the absence of one. An
// unclean shutdown leaves this behind: the filesystem extended the file's
// recorded length but never flushed the data blocks, so the tail reads as
// zeros. Nothing was written there, so nothing can be read back — replaying it
// fails identically every time, forever.
//
// That matters because `quarantined` is the number to alert on, and its whole
// meaning is "data is waiting, not lost". A record that can never be recovered
// pins that number above zero permanently, and a permanently-red alert is one
// nobody reads — it would also hide the next real quarantine behind it. So this
// is recognised on the way in and parked as resolved, with the row and its
// payload kept intact for inspection.
export const unrecoverableReason = (payload: string): string | null => {
  if (payload.length === 0) return null
  const nuls = (payload.match(/\u0000/g) ?? []).length
  if (nuls === 0) return null
  // Only when there is nothing else. A record that merely *contains* a NUL may
  // still hold a recoverable message, and guessing it away would drop data.
  if (/[^\u0000\s]/.test(payload)) return null
  return `unrecoverable: ${nuls} NUL bytes and no content — an unflushed write, not a damaged record`
}

// Returns the quarantine row id, or null if even this failed.
export const quarantine = async (input: QuarantineInput): Promise<number | null> => {
  const unrecoverable = unrecoverableReason(input.payload)
  try {
    const result = await query<{ id: number }>(
      // resolved_at is decided here rather than only on replay, because a full
       // re-sync re-quarantines the same line: were the conflict branch to reset
       // it to NULL unconditionally, every re-sync would resurrect a record that
       // can never be recovered and the alert would come back from the dead.
      `INSERT INTO sync_quarantine (
         source, machine, file_path, record_key, line_number,
         session_external_id, session_id, project_id, stage, payload_base64, error,
         resolved_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         CASE WHEN $12 THEN NOW() ELSE NULL END)
       ON CONFLICT (source, file_path, record_key) DO UPDATE SET
         attempts = sync_quarantine.attempts + 1,
         last_attempt_at = NOW(),
         error = $11,
         payload_base64 = $10,
         session_id = COALESCE($7, sync_quarantine.session_id),
         resolved_at = CASE WHEN $12 THEN NOW() ELSE NULL END
       RETURNING id`,
      [
        input.source,
        config.machine,
        normalizeText(input.filePath),
        normalizeText(input.recordKey),
        input.lineNumber ?? null,
        input.sessionExternalId == null ? null : normalizeText(input.sessionExternalId),
        input.sessionId ?? null,
        input.projectId ?? null,
        input.stage,
        encodePayload(input.payload),
        unrecoverable ? `${message(input.error)} — ${unrecoverable}` : message(input.error),
        unrecoverable !== null,
      ]
    )
    return result.rows[0]?.id ?? null
  } catch (e) {
    console.error(
      `[quarantine] could not store failed record ${input.filePath}#${input.recordKey}:`,
      message(e)
    )
    return null
  }
}

export type QuarantineRow = {
  id: number
  source: string
  machine: string | null
  filePath: string
  recordKey: string
  lineNumber: number | null
  sessionExternalId: string | null
  sessionId: number | null
  projectId: number | null
  stage: QuarantineStage
  error: string
  attempts: number
  firstSeenAt: string
  lastAttemptAt: string
  resolvedAt: string | null
  // The decoded record. Present only when asked for — a listing does not need
  // to carry every payload.
  payload?: string
}

type Row = {
  id: number
  source: string
  machine: string | null
  file_path: string
  record_key: string
  line_number: number | null
  session_external_id: string | null
  session_id: number | null
  project_id: number | null
  stage: QuarantineStage
  error: string
  attempts: number
  first_seen_at: string
  last_attempt_at: string
  resolved_at: string | null
  payload_base64?: string
}

const toRow = (r: Row): QuarantineRow => ({
  id: Number(r.id),
  source: r.source,
  machine: r.machine,
  filePath: r.file_path,
  recordKey: r.record_key,
  lineNumber: r.line_number,
  sessionExternalId: r.session_external_id,
  sessionId: r.session_id,
  projectId: r.project_id,
  stage: r.stage,
  error: r.error,
  attempts: r.attempts,
  firstSeenAt: r.first_seen_at,
  lastAttemptAt: r.last_attempt_at,
  resolvedAt: r.resolved_at,
  ...(r.payload_base64 === undefined ? {} : { payload: decodePayload(r.payload_base64) }),
})

export const listQuarantine = async (opts: {
  limit: number
  offset: number
  includeResolved?: boolean
  withPayload?: boolean
}): Promise<{ items: QuarantineRow[]; total: number }> => {
  const where = opts.includeResolved ? '' : 'WHERE resolved_at IS NULL'
  const payloadColumn = opts.withPayload ? 'payload_base64,' : ''
  const result = await query<Row & { total: string }>(
    `SELECT id, source, machine, file_path, record_key, line_number,
            session_external_id, session_id, project_id, stage, error, attempts,
            first_seen_at, last_attempt_at, resolved_at, ${payloadColumn}
            COUNT(*) OVER() AS total
     FROM sync_quarantine
     ${where}
     ORDER BY last_attempt_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [opts.limit, opts.offset]
  )
  return {
    total: result.rows[0] ? Number(result.rows[0].total) : 0,
    items: result.rows.map(toRow),
  }
}

export const countPending = async (): Promise<number> => {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM sync_quarantine WHERE resolved_at IS NULL`
  )
  return Number(result.rows[0]?.count ?? 0)
}

const markResolved = async (id: number) => {
  await query(`UPDATE sync_quarantine SET resolved_at = NOW() WHERE id = $1`, [id])
}

const markAttempted = async (id: number, error: unknown) => {
  await query(
    `UPDATE sync_quarantine
     SET attempts = attempts + 1, last_attempt_at = NOW(), error = $2
     WHERE id = $1`,
    [id, message(error)]
  )
}

// `unrecoverable` is not a failure the caller should retry: it is the verdict
// that retrying is pointless. Counted separately from `recovered` so a replay
// summary cannot read as "5 still to go" when the answer is "5 never existed".
export type ReplayOutcome = { id: number; ok: boolean; error?: string; unrecoverable?: boolean }

// A quarantined record goes back in through exactly the path it failed on:
// a 'parse' payload is re-parsed with parseClaudeLine, an 'insert' payload is
// the parsed message itself. Both end at the same insert, so a replay can never
// write something a normal sync would not have.
const replayRow = async (row: QuarantineRow): Promise<ReplayOutcome> => {
  if (!row.payload) return { id: row.id, ok: false, error: 'payload missing' }

  // Rows quarantined before this was recognised, and any that slip through.
  // Resolved, not deleted: the payload stays for inspection, it just stops
  // being counted as work waiting to be done.
  const unrecoverable = unrecoverableReason(row.payload)
  if (unrecoverable) {
    await markResolved(row.id)
    return { id: row.id, ok: false, unrecoverable: true, error: unrecoverable }
  }

  // Spooled ingests replay through exactly the path they failed on: the same
  // schema, the same ingestConversation. The session-resolution below is
  // Claude-transcript machinery and does not apply — an IngestPayload carries
  // its whole conversation with it.
  if (row.source === SPOOL_QUARANTINE_SOURCE) {
    try {
      // Imported here, not at the top: ingest.ts reaches the chroma and
      // ollama clients through search.ts, and quarantining must stay loadable
      // (and testable) with nothing but Postgres behind it.
      const { ingestConversation } = await import('../mcp/ingest.js')
      await ingestConversation(IngestPayloadSchema.parse(JSON.parse(row.payload)))
      await markResolved(row.id)
      return { id: row.id, ok: true }
    } catch (e) {
      await markAttempted(row.id, e)
      return { id: row.id, ok: false, error: message(e) }
    }
  }

  // A record quarantined before its session existed carries the project and the
  // session's external id instead; resolve it now that sync has caught up.
  const sessionId =
    row.sessionId ??
    (row.projectId != null && row.sessionExternalId
      ? ((await queries.getSessionByExternalId(row.projectId, row.sessionExternalId))?.id ?? null)
      : null)

  // Recorded as an attempt so the row shows what is blocking it *now*, not the
  // error it first arrived with.
  if (sessionId == null) {
    const blocked = 'no session for this record yet — re-sync the file first'
    await markAttempted(row.id, blocked)
    return { id: row.id, ok: false, error: blocked }
  }

  const parsed: ParsedMessage =
    row.stage === 'parse'
      ? (() => {
          const result = parseClaudeLine(row.payload!, 0)
          if (result.kind !== 'message') throw new Error(`still unusable: ${result.reason}`)
          return result.message
        })()
      : (() => {
          const raw = JSON.parse(row.payload!) as ParsedMessage
          return { ...raw, timestamp: new Date(raw.timestamp) }
        })()

  await queries.insertMessage({
    sessionId,
    externalId: parsed.uuid,
    role: parsed.role,
    contentText: parsed.contentText,
    contentJson: parsed.contentJson,
    toolName: parsed.toolName,
    toolInput: parsed.toolInput,
    thinkingText: parsed.thinkingText,
    model: parsed.model,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    cacheCreationTokens: parsed.cacheCreationTokens,
    cacheReadTokens: parsed.cacheReadTokens,
    timestamp: parsed.timestamp,
    sequenceNum: parsed.sequenceNum,
    isSidechain: parsed.isSidechain,
  })

  await queries.updateSessionStats(sessionId)
  await markResolved(row.id)
  return { id: row.id, ok: true }
}

// Replays pending records. A record that fails again keeps its row, with the
// new error and a bumped attempt count — retrying is always safe.
export const replayQuarantine = async (opts: { limit?: number; id?: number } = {}) => {
  const result = await query<Row>(
    opts.id != null
      ? `SELECT id, source, machine, file_path, record_key, line_number,
                session_external_id, session_id, project_id, stage, error, attempts,
                first_seen_at, last_attempt_at, resolved_at, payload_base64
         FROM sync_quarantine WHERE id = $1`
      : `SELECT id, source, machine, file_path, record_key, line_number,
                session_external_id, session_id, project_id, stage, error, attempts,
                first_seen_at, last_attempt_at, resolved_at, payload_base64
         FROM sync_quarantine
         WHERE resolved_at IS NULL
         ORDER BY first_seen_at ASC
         LIMIT $1`,
    [opts.id ?? opts.limit ?? 100]
  )

  const outcomes: ReplayOutcome[] = []
  for (const raw of result.rows) {
    const row = toRow(raw)
    try {
      outcomes.push(await replayRow(row))
    } catch (e) {
      // Recording the attempt must never abort the rest of the batch: one
      // record whose bookkeeping fails still leaves every other record
      // replayable, and its own row keeps the previous error.
      try {
        await markAttempted(row.id, e)
      } catch (attemptError) {
        console.error(`[quarantine] could not record attempt for row ${row.id}:`, message(attemptError))
      }
      outcomes.push({ id: row.id, ok: false, error: message(e) })
    }
  }

  return {
    attempted: outcomes.length,
    recovered: outcomes.filter(o => o.ok).length,
    unrecoverable: outcomes.filter(o => o.unrecoverable).length,
    outcomes,
  }
}
