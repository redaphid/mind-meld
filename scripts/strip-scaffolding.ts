// Backfill: strip harness scaffolding from messages stored before the parser
// began doing it (issue #37).
//
// Supersedes the earlier hook-injection-only pass. That one removed four named
// varieties of `<system-reminder>`; this one removes every `<system-reminder>`
// and unwraps slash-command XML as well, using the exact same code the parser
// now runs (`stripScaffolding`) and the exact same decision function a dry run
// reports (`planStrip`). One implementation, so what you preview is what runs.
//
// SAFETY — this script does not mutate anything unless you tell it to:
//
//   * Dry run is the DEFAULT. Without `--apply` it writes nothing at all and
//     prints exactly what it would do, with samples — including the number of
//     sessions it would reset, which is the one step that costs real time to
//     rebuild.
//   * Every original is copied into `message_content_backup`, and every session
//     chunk into `session_chunk_backup`, BEFORE anything is overwritten or
//     deleted. See `--revert`.
//   * Vectors bound for deletion in Chroma are journalled before their Postgres
//     rows are dropped, so an interrupted run is finished by the next one
//     rather than leaving an unreachable vector behind.
//   * Content is unwrapped, never truncated: markup is removed and payload is
//     kept. A message whose only content was markup becomes UNEMBEDDABLE
//     rather than being embedded as an empty husk.
//
// Sequencing lives in `src/embeddings/scaffolding-backfill-run.ts` and is unit
// tested there; this file is the CLI and the SQL.
//
// Usage:
//   pnpm tsx scripts/strip-scaffolding.ts            # dry run (default)
//   pnpm tsx scripts/strip-scaffolding.ts --apply    # perform the backfill
//   pnpm tsx scripts/strip-scaffolding.ts --revert   # preview a restore
//   pnpm tsx scripts/strip-scaffolding.ts --revert --apply         # restore
//   pnpm tsx scripts/strip-scaffolding.ts --purge-backups --apply  # drop undo data

import { query, closePool } from '../src/db/postgres.js'
import { deleteByIds } from '../src/db/chroma.js'
import { config } from '../src/config.js'
import type { StripPlan } from '../src/embeddings/scaffolding-backfill.js'
import {
  runBackfill,
  runRevert,
  type BackfillCandidate,
  type BackfillStore,
  type RevertStore,
} from '../src/embeddings/scaffolding-backfill-run.js'

const APPLY = process.argv.includes('--apply')
const REVERT = process.argv.includes('--revert')
const PURGE = process.argv.includes('--purge-backups')

const COLLECTION = {
  messages: config.chroma.collections.messages,
  sessions: config.chroma.collections.sessions,
  chunks: config.chroma.collections.chunks,
} as const

// The tables live in `init-db/019-scaffolding-backfill-backups.sql` and are
// applied by the normal migration runner. This is only a guard for a database
// that has not been migrated yet, so a backfill cannot start writing with
// nowhere to put the undo data.
const BACKUP_TABLES = ['message_content_backup', 'session_chunk_backup', 'chroma_pending_deletes']

const missingTables = async () => {
  const { rows } = await query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_name = ANY($1::text[])`,
    [BACKUP_TABLES]
  )
  return BACKUP_TABLES.filter((t) => !rows.some((r) => r.name === t))
}

const requireTables = async () => {
  const missing = await missingTables()
  if (missing.length > 0)
    throw new Error(
      `Missing backup tables: ${missing.join(', ')}. Run migrations first (pnpm tsx scripts/migrate.ts).`
    )
}

// `has_vector` is carried alongside so the run can report how many embeddings
// it actually removes rather than how many it would have tried to. Most of
// these messages were never embedded at all; counting intent would overstate
// the blast radius to whoever is approving the run.
//
// The scan set matches every tag `stripScaffolding` acts on. `<command-args>`
// and `<command-contents>` never appear without a `<command-name>` today, but
// the strip set and the scan set disagreeing is exactly how a message gets
// missed the day that stops being true.
const pickBatch = async (afterId: number, limit: number): Promise<BackfillCandidate[]> => {
  const { rows } = await query<BackfillCandidate>(
    `SELECT m.id, m.session_id, m.content_text,
            (e.id IS NOT NULL) AS has_vector
       FROM messages m
       LEFT JOIN embeddings e
         ON e.message_id = m.id AND e.chroma_collection = $3
      WHERE m.id > $1
        AND m.content_text IS NOT NULL
        AND (m.content_text LIKE '%<command-name%'
          OR m.content_text LIKE '%<command-message%'
          OR m.content_text LIKE '%<command-args%'
          OR m.content_text LIKE '%<command-contents%'
          OR m.content_text LIKE '%<system-reminder%'
          OR m.content_text LIKE '%<local-command-caveat%'
          OR m.content_text LIKE '%<local-command-stdout%')
      ORDER BY m.id
      LIMIT $2`,
    [afterId, limit, COLLECTION.messages]
  )
  return rows
}

const DRAIN_PAGE = 500

const store: BackfillStore = {
  ensureTables: requireTables,

  pickBatch,

  saveOriginal: async (plan) => {
    await query(
      `INSERT INTO message_content_backup (message_id, content_text, reason)
       VALUES ($1, $2, $3) ON CONFLICT (message_id) DO NOTHING`,
      [plan.id, plan.original, plan.reason]
    )
  },

  applyStripped: async (plan) => {
    await query(`UPDATE messages SET content_text = $1 WHERE id = $2`, [plan.stripped, plan.id])
  },

  markUnembeddable: async (messageId) => {
    await query(
      `INSERT INTO embeddings (message_id, chroma_collection, chroma_id, embedding_model,
         dimensions, content_chars_at_embed, failure_reason, failure_detail, retry_count, updated_at)
       VALUES ($1, 'UNEMBEDDABLE', 'unembeddable-' || $1, 'none', 0, 0, 'noise', 'scaffolding-only', 0, NOW())
       ON CONFLICT (message_id, chroma_collection)
       DO UPDATE SET failure_reason = 'noise', failure_detail = 'scaffolding-only', updated_at = NOW()`,
      [messageId]
    )
  },

  queueVectorDelete: async ({ collection, chromaId }) => {
    await query(
      `INSERT INTO chroma_pending_deletes (chroma_collection, chroma_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [COLLECTION[collection as keyof typeof COLLECTION] ?? collection, chromaId]
    )
  },

  forgetVectorRow: async (messageId) => {
    await query(`DELETE FROM embeddings WHERE message_id = $1 AND chroma_collection = $2`, [
      messageId,
      COLLECTION.messages,
    ])
  },

  drainVectorDeletes: async () => {
    let drained = 0
    for (;;) {
      const { rows } = await query<{ chroma_collection: string; chroma_id: string }>(
        `SELECT chroma_collection, chroma_id FROM chroma_pending_deletes
          ORDER BY queued_at, chroma_id LIMIT $1`,
        [DRAIN_PAGE]
      )
      if (rows.length === 0) return drained

      const byCollection = new Map<string, string[]>()
      for (const row of rows) {
        const ids = byCollection.get(row.chroma_collection) ?? []
        ids.push(row.chroma_id)
        byCollection.set(row.chroma_collection, ids)
      }
      for (const [collection, ids] of byCollection) {
        await deleteByIds(collection, ids)
        // The row goes with the vector. A crash between `queueVectorDelete` and
        // `forgetVectorRow` would otherwise leave an `embeddings` row naming a
        // vector that no longer exists, which the pending query reads as
        // "already embedded" — the message would sit out of the queue forever
        // with nothing wrong-looking anywhere.
        await query(
          `DELETE FROM embeddings WHERE chroma_collection = $1 AND chroma_id = ANY($2::text[])`,
          [collection, ids]
        )
        // Only now is the intent discharged. Crash before this and the next run
        // deletes the same ids again, which Chroma treats as a no-op.
        await query(
          `DELETE FROM chroma_pending_deletes
            WHERE chroma_collection = $1 AND chroma_id = ANY($2::text[])`,
          [collection, ids]
        )
        drained += ids.length
      }
    }
  },

  saveSessionChunks: async (sessionIds) => {
    await query(
      `INSERT INTO session_chunk_backup
         (id, session_id, chunk_index, start_message_id, end_message_id, summary, content_chars, created_at)
       SELECT id, session_id, chunk_index, start_message_id, end_message_id, summary, content_chars, created_at
         FROM session_chunks WHERE session_id = ANY($1::bigint[])
       ON CONFLICT (id) DO NOTHING`,
      [sessionIds]
    )
  },

  resetSessions: async (sessionIds) => {
    const sessionChromaIds = sessionIds.map((id) => `session-${id}`)

    // Journal both the session vectors and the chunk vectors before deleting
    // anything. Deleting `session_chunks` cascades their `convo-chunks`
    // embedding rows away, which would otherwise strand those vectors in Chroma
    // with nothing left in Postgres that knows their ids.
    await query(
      `INSERT INTO chroma_pending_deletes (chroma_collection, chroma_id)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [COLLECTION.sessions, sessionChromaIds]
    )
    await query(
      `INSERT INTO chroma_pending_deletes (chroma_collection, chroma_id)
       SELECT $1, 'chunk-' || id FROM session_chunks WHERE session_id = ANY($2::bigint[])
       ON CONFLICT DO NOTHING`,
      [COLLECTION.chunks, sessionIds]
    )

    await query(
      `DELETE FROM embeddings WHERE chroma_collection = $1 AND chroma_id = ANY($2::text[])`,
      [COLLECTION.sessions, sessionChromaIds]
    )
    await query(`DELETE FROM session_chunks WHERE session_id = ANY($1::bigint[])`, [sessionIds])
  },
}

const revertStore: RevertStore = {
  countBackups: async () => {
    const { rows } = await query<{ count: string }>(
      `SELECT count(*) AS count FROM message_content_backup`
    )
    return Number(rows[0]?.count ?? 0)
  },

  countChunkBackups: async () => {
    const { rows } = await query<{ count: string }>(
      `SELECT count(*) AS count FROM session_chunk_backup`
    )
    return Number(rows[0]?.count ?? 0)
  },

  restoreText: async () => {
    const result = await query(
      `UPDATE messages m SET content_text = b.content_text
         FROM message_content_backup b WHERE m.id = b.message_id`
    )
    return result.rowCount ?? 0
  },

  clearTerminalNoise: async () => {
    // `noise` has no healing path: `src/embeddings/batch.ts` only retries
    // `nan`. Both the row this script writes (`scaffolding-only`) and the one
    // the worker writes afterwards for text that fell under the length floor
    // (`too-short:NN`) are consequences of the backfill, so both go. The worker
    // re-classifies the restored text through the normal path — self-healing,
    // and visible in the logs either way.
    const result = await query(
      `DELETE FROM embeddings
        WHERE chroma_collection = 'UNEMBEDDABLE'
          AND failure_reason = 'noise'
          AND message_id IN (SELECT message_id FROM message_content_backup)`
    )
    return result.rowCount ?? 0
  },

  restoreSessionChunks: async () => {
    const result = await query(
      `INSERT INTO session_chunks
         (id, session_id, chunk_index, start_message_id, end_message_id, summary, content_chars, created_at)
       SELECT b.id, b.session_id, b.chunk_index, b.start_message_id, b.end_message_id,
              b.summary, b.content_chars, b.created_at
         FROM session_chunk_backup b
        WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.id = b.session_id)
       ON CONFLICT DO NOTHING`
    )
    // Explicit ids were reinserted underneath a BIGSERIAL; without this the
    // next generated chunk id collides with a restored one.
    await query(
      `SELECT setval(pg_get_serial_sequence('session_chunks','id'),
                     GREATEST(COALESCE((SELECT MAX(id) FROM session_chunks), 1), 1))`
    )
    return result.rowCount ?? 0
  },
}

const preview = (plan: StripPlan) => {
  // Debug output only, never returned to an API consumer — the no-truncation
  // policy explicitly permits eliding here.
  const oneLine = (s: string) => JSON.stringify(s.length > 160 ? `${s.slice(0, 160)}…` : s)
  return (
    `  #${plan.id} [${plan.action}/${plan.reason}] -${(plan.removedFraction * 100).toFixed(0)}%\n` +
    `    before: ${oneLine(plan.original)}\n` +
    `    after:  ${oneLine(plan.stripped)}`
  )
}

// A missing backup table means the backfill was never applied on this database,
// which is a state to report plainly rather than an error to stack-trace at
// someone who is trying to undo something.
const noBackfillHere = async () => {
  const missing = await missingTables()
  if (missing.length === 0) return false
  console.log(
    'Nothing to revert: the backup tables do not exist on this database, so the backfill has ' +
      'never been applied here.\n' +
      `(Missing: ${missing.join(', ')} — run migrations if you expected them.)`
  )
  return true
}

const revert = async () => {
  if (await noBackfillHere()) return
  const summary = await runRevert(revertStore, { apply: APPLY })

  if (summary.restored === 0 && summary.chunksRestored === 0) {
    console.log('Nothing to revert: the backup tables are empty.')
    return
  }

  if (!summary.applied) {
    console.log(
      `DRY RUN — would restore ${summary.restored} messages and ${summary.chunksRestored} session chunks,\n` +
        `and clear the terminal UNEMBEDDABLE rows blocking those messages from being re-embedded.`
    )
    console.log('Re-run with --revert --apply to perform the restore.')
    return
  }

  console.log(
    `Restored ${summary.restored} messages and ${summary.chunksRestored} session chunks.\n` +
      `Cleared ${summary.requeued} terminal UNEMBEDDABLE rows, so those messages re-enter the queue.`
  )
  console.log(
    'Vectors are not restored directly: the embedding worker regenerates message vectors from the\n' +
      'restored text and the aggregate pass rebuilds session summaries and chunk embeddings.\n' +
      'Note that the worker judges noise on scaffolding-stripped text (src/embeddings/classify.ts),\n' +
      'so a message that was nothing but a wrapper is marked unembeddable again — through the normal\n' +
      'path, with a logged reason. Undoing that judgement means reverting the code, not the data.'
  )
}

const purgeBackups = async () => {
  if (await noBackfillHere()) return
  const messages = await revertStore.countBackups()
  const chunks = await revertStore.countChunkBackups()
  if (!APPLY) {
    console.log(
      `DRY RUN — would delete ${messages} message backups and ${chunks} session-chunk backups.\n` +
        'After this the backfill can no longer be reverted. Re-run with --purge-backups --apply.'
    )
    return
  }
  await query(`DELETE FROM message_content_backup`)
  await query(`DELETE FROM session_chunk_backup`)
  console.log(`Purged ${messages} message backups and ${chunks} session-chunk backups.`)
  console.log('The backfill is no longer revertible.')
}

const main = async () => {
  if (PURGE) return purgeBackups()
  if (REVERT) return revert()

  if (!APPLY)
    console.log('DRY RUN — nothing will be written. Re-run with --apply to perform it.\n')

  const summary = await runBackfill(store, { apply: APPLY }, (progress) => {
    console.log(
      `scanned=${progress.scanned} rewrite=${progress.rewrite} unembeddable=${progress.unembeddable} ` +
        `skip=${progress.skip} vectorsDropped=${progress.vectorsDropped} ` +
        `sessionsReset=${progress.sessionsReset}`
    )
  })

  if (summary.samples.length > 0) {
    console.log('\nSamples:')
    for (const plan of summary.samples) console.log(preview(plan))
  }

  console.log(
    `\n${APPLY ? 'done' : 'DRY RUN — nothing written'}. scanned=${summary.scanned} ` +
      `rewrite=${summary.rewrite} unembeddable=${summary.unembeddable} skip=${summary.skip} ` +
      `vectorsDropped=${summary.vectorsDropped} sessionsReset=${summary.sessionsReset}`
  )
  console.log(
    `sessionsReset deletes every session_chunk of those ${summary.sessionsReset} sessions; the chunks are ` +
      'copied to session_chunk_backup first and --revert puts them back.'
  )
  // `rewrite` reads as "kept", and for the short ones that is only half true.
  // The text is kept and full-text search still finds them; the vector is
  // dropped, the message requeues, and the worker refuses it on length. Anyone
  // approving this run is approving that too, so it is printed next to the
  // number they are approving rather than left to be discovered afterwards.
  console.log(
    `\nSemantic findability: ${summary.unembeddableAfter} messages are left unembeddable ` +
      `(${summary.unembeddable} scaffolding husks + ${summary.shortAfterStrip} rewrites whose surviving ` +
      `text falls under the 50-character embedding floor). ${summary.findabilityLost} of them hold a ` +
      'vector today, so that many lose semantic findability they currently have. All remain in full-text ' +
      'search, and --revert clears the terminal rows for every one of them.'
  )
  if (!APPLY)
    console.log('Re-run with --apply to perform the backfill (originals are backed up).')
  else
    console.log(
      'Undo data is retained in message_content_backup / session_chunk_backup until you run ' +
        '--purge-backups --apply.'
    )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => closePool())
