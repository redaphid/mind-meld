import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { transaction } from '../db/postgres.js'
import { normalizeDeep } from '../utils/text-encoding.js'
import type { IngestPayload } from './ingest-schema.js'

export class SnapshotConflictError extends Error {}

const canonicalJson = (value: unknown): string => {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  return JSON.stringify(value)
}

export const ingestSnapshot = async (sourceId: number, input: IngestPayload) => {
  const payload = normalizeDeep(input)
  assert(payload.snapshot, new SnapshotConflictError('Snapshot revision is required'))
  const revision = payload.snapshot.revision
  const externalId = payload.session.externalId
  const hash = createHash('sha256').update(canonicalJson({ session: payload.session, messages: payload.messages, os: payload.os ?? null })).digest('hex')
  return transaction(async client => {
    await client.query(`INSERT INTO projects (source_id, external_id) VALUES ($1, $2) ON CONFLICT (source_id, external_id) DO NOTHING`, [sourceId, payload.project.externalId])
    const project = await client.query<{ id: number }>(`SELECT id FROM projects WHERE source_id = $1 AND external_id = $2`, [sourceId, payload.project.externalId])
    const projectId = project.rows[0].id
    const classification = await client.query<{ data_class: string }>(
      `SELECT COALESCE(p.data_class, src.data_class) AS data_class FROM projects p JOIN sources src ON src.id = p.source_id WHERE p.id = $1`, [projectId]
    )
    assert(classification.rows[0].data_class === payload.dataClass, new SnapshotConflictError('Snapshot dataClass must match the stored project class'))
    await client.query(`INSERT INTO ingest_heads (project_id, external_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [projectId, externalId])
    const result = await client.query<{ revision: string; content_hash: string; current_session_id: number | null }>(
      `SELECT revision, content_hash, current_session_id FROM ingest_heads WHERE project_id = $1 AND external_id = $2 FOR UPDATE`, [projectId, externalId]
    )
    const head = result.rows[0]
    const currentRevision = Number(head.revision)
    if (revision < currentRevision)
      return { projectId, status: 'stale', revision: currentRevision, sessionId: head.current_session_id, messagesInserted: 0 }
    assert(revision !== currentRevision || hash === head.content_hash, new SnapshotConflictError('Snapshot revision already contains different content'))
    if (revision > currentRevision)
      await client.query(
        `UPDATE projects SET name = $2, path = COALESCE($3, path), machine = COALESCE($4, machine), os = COALESCE($5, os), last_synced_at = NOW() WHERE id = $1`,
        [projectId, payload.project.name, payload.project.path ?? null, payload.machine ?? null, payload.os ?? null]
      )
    if (hash === head.content_hash) {
      await client.query(`UPDATE ingest_heads SET revision = $3 WHERE project_id = $1 AND external_id = $2`, [projectId, externalId, revision])
      return { projectId, status: 'unchanged', revision, sessionId: head.current_session_id, messagesInserted: 0 }
    }
    let sessionId: number | null = null
    if (payload.messages.length > 0) {
      const logicalHash = createHash('sha256').update(externalId).digest('hex')
      const session = await client.query<{ id: number }>(
        `INSERT INTO sessions (project_id, external_id, title, started_at, ended_at, os, is_automated, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, false, NOW()) RETURNING id`,
        [projectId, `snapshot:${logicalHash}:${revision}:${hash}`, payload.session.title, payload.session.startedAt, payload.session.endedAt ?? null, payload.os ?? null]
      )
      sessionId = session.rows[0].id
      for (const message of payload.messages)
        await client.query(
          `INSERT INTO messages (session_id, external_id, role, content_text, content_json, timestamp, sequence_num) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [sessionId, message.externalId, message.role, message.content, message.metadata === undefined ? null : JSON.stringify(message.metadata), message.timestamp, message.sequenceNum]
        )
      await client.query('SELECT update_session_stats($1::integer)', [sessionId])
      await client.query(`UPDATE sessions SET content_chars = (SELECT COALESCE(SUM(LENGTH(content_text)), 0) FROM messages WHERE session_id = $1) WHERE id = $1`, [sessionId])
    }
    await client.query(`UPDATE sessions SET deleted_at = NOW(), centroid_vector = NULL WHERE id = $1`, [head.current_session_id])
    await client.query(`UPDATE projects SET centroid_vector = NULL, centroid_computed_at = NULL WHERE id = $1`, [projectId])
    await client.query(`UPDATE ingest_heads SET revision = $3, content_hash = $4, current_session_id = $5 WHERE project_id = $1 AND external_id = $2`, [projectId, externalId, revision, hash, sessionId])
    return { projectId, status: 'applied', revision, sessionId, messagesInserted: payload.messages.length }
  })
}
