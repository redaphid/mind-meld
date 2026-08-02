import { z } from 'zod'
import { queries } from '../db/postgres.js'
import { listKnownDataClasses } from './search.js'

const IngestMessageSchema = z.object({
  externalId: z.string(),
  role: z.string(),
  content: z.string(),
  timestamp: z.string().transform(s => new Date(s)),
  sequenceNum: z.number(),
  metadata: z.record(z.unknown()).optional(),
})

export const IngestPayloadSchema = z.object({
  source: z.string(),
  sourceDisplayName: z.string().optional(),
  // Classification for the source ('coding' | 'personal' | 'meetings' | ...,
  // open vocabulary). REQUIRED when the ingest would create a new source —
  // enforced in ingestConversation, where we can see whether the source
  // exists. An existing source keeps its current class regardless of what is
  // sent. Normalized like the search side: a source stamped "Coding " would
  // be unreachable.
  dataClass: z
    .string()
    .max(32)
    .optional()
    .transform(s => s?.trim().toLowerCase() || undefined),
  // The sending computer. Omitted means "unknown" — we record nothing rather
  // than mislabelling it as the machine running this server.
  machine: z.string().max(64).optional(),
  // The sending computer's operating system (#33): `win32` | `wsl` | `linux`
  // | `darwin` | … Same rule as `machine` — omitted means "unknown" and is
  // recorded as null, because a relayed thread did not come from this
  // server's OS. It is the fact that makes a `/mnt/<letter>` path comparison
  // sound rather than assumed, so guessing it would be worse than lacking it.
  os: z.string().max(32).optional(),
  project: z.object({
    externalId: z.string(),
    name: z.string(),
    path: z.string().optional(),
  }),
  session: z.object({
    externalId: z.string(),
    title: z.string(),
    startedAt: z.string().transform(s => new Date(s)),
    endedAt: z.string().transform(s => new Date(s)).optional(),
  }),
  messages: z.array(IngestMessageSchema),
})

export type IngestPayload = z.infer<typeof IngestPayloadSchema>

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
