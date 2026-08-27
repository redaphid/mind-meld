import { queries } from '../db/postgres.js'
import { listKnownDataClasses } from './search.js'
import { IngestPayloadSchema, type IngestPayload } from './ingest-schema.js'

// The schema lives in ingest-schema.ts so the edge acceptor (mcp-gateway/)
// can share it without pulling in the Postgres client; re-exported here so
// existing importers keep working.
export { IngestPayloadSchema, type IngestPayload }

// A new source's class decides who sees its data (issue #60): defaulting it
// silently was the bug, so creating a source now demands an explicit choice.
// The message names the vocabulary in use so the caller can pick, not guess.
export class MissingDataClassError extends Error {
  constructor(source: string, known: string[]) {
    const vocabulary = known.length > 0 ? known.join(', ') : 'none yet'
    super(
      `dataClass is required: this ingest would create the new source "${source}". ` +
        `Classes in use: ${vocabulary}. The vocabulary is open — any lowercase label ` +
        `up to 32 chars is accepted — and only "coding" is visible to the default search. ` +
        `An existing source's class is never changed by ingest.`
    )
    this.name = 'MissingDataClassError'
  }
}

// The whole ingest flow behind POST /api/ingest. Source, project, and session
// are upsert-keyed on externalId; messages are insert-on-conflict-do-nothing,
// so messagesInserted counts only rows that were new. The returned dataClass
// is the source's STORED class — for an existing source that may differ from
// what the caller sent, since ingest deliberately cannot reclassify.
export const ingestConversation = async (payload: IngestPayload) => {
  const existing = await queries.getSourceByName(payload.source)
  if (!existing && !payload.dataClass)
    throw new MissingDataClassError(payload.source, await listKnownDataClasses())

  const source = await queries.getOrCreateSource(
    payload.source,
    payload.sourceDisplayName,
    payload.dataClass
  )

  const projectId = await queries.upsertProject(
    source.id,
    payload.project.externalId,
    payload.project.path ?? '',
    payload.project.name,
    payload.machine ?? null,
    payload.os ?? null
  )

  const sessionId = await queries.upsertSession({
    projectId,
    externalId: payload.session.externalId,
    title: payload.session.title,
    startedAt: payload.session.startedAt,
    endedAt: payload.session.endedAt,
    os: payload.os ?? null,
  })

  let messagesInserted = 0
  for (const msg of payload.messages) {
    const msgId = await queries.insertMessage({
      sessionId,
      externalId: msg.externalId,
      role: msg.role,
      contentText: msg.content,
      contentJson: msg.metadata,
      timestamp: msg.timestamp,
      sequenceNum: msg.sequenceNum,
    })
    if (msgId) messagesInserted++
  }

  await queries.updateSessionStats(sessionId)

  return { sourceId: source.id, projectId, sessionId, messagesInserted, dataClass: source.data_class }
}
