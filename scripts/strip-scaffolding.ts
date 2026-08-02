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
//     prints exactly what it would do, with samples.
//   * Every original is copied into `message_content_backup` BEFORE its row is
//     rewritten, so the pass is reversible. See `--revert`.
//   * Content is unwrapped, never truncated: markup is removed and payload is
//     kept. A message whose only content was markup becomes UNEMBEDDABLE
//     rather than being embedded as an empty husk.
//
// Usage:
//   pnpm tsx scripts/strip-scaffolding.ts            # dry run (default)
//   pnpm tsx scripts/strip-scaffolding.ts --apply    # perform the backfill
//   pnpm tsx scripts/strip-scaffolding.ts --revert   # preview a restore
//   pnpm tsx scripts/strip-scaffolding.ts --revert --apply   # restore

import { query, closePool } from '../src/db/postgres.js'
import { deleteByIds } from '../src/db/chroma.js'
import { config } from '../src/config.js'
import { planStrip, type BackfillRow, type StripPlan } from '../src/embeddings/scaffolding-backfill.js'

const APPLY = process.argv.includes('--apply')
const REVERT = process.argv.includes('--revert')
const BATCH = 500

// Holds the pre-strip text so the backfill can be undone. Keyed by message so a
// re-run cannot stack backups on top of each other and lose the true original.
const ensureBackupTable = async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS message_content_backup (
      message_id   BIGINT PRIMARY KEY,
      content_text TEXT NOT NULL,
      reason       TEXT NOT NULL,
      backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
}

// `has_vector` is carried alongside so the run can report how many embeddings
// it actually removes rather than how many it would have tried to. Most of
// these messages were never embedded at all; counting intent would overstate
// the blast radius to whoever is approving the run.
const pickBatch = (afterId: number) =>
  query<BackfillRow & { has_vector: boolean }>(
    `SELECT m.id, m.session_id, m.content_text,
            (e.id IS NOT NULL) AS has_vector
       FROM messages m
       LEFT JOIN embeddings e
         ON e.message_id = m.id AND e.chroma_collection = $3
      WHERE m.id > $1
        AND m.content_text IS NOT NULL
        AND (m.content_text LIKE '%<command-name>%'
          OR m.content_text LIKE '%<command-message>%'
          OR m.content_text LIKE '%<system-reminder>%'
          OR m.content_text LIKE '%<local-command-caveat>%'
          OR m.content_text LIKE '%<local-command-stdout>%')
      ORDER BY m.id
      LIMIT $2`,
    [afterId, BATCH, config.chroma.collections.messages]
  )

const revert = async () => {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*) AS count FROM message_content_backup`
  )
  const total = Number(rows[0]?.count ?? 0)
  if (total === 0) {
    console.log('Nothing to revert: message_content_backup is empty.')
    return
  }
  if (!APPLY) {
    console.log(`DRY RUN — would restore ${total} messages from message_content_backup.`)
    console.log('Re-run with --revert --apply to perform the restore.')
    return
  }
  const result = await query(
    `UPDATE messages m
        SET content_text = b.content_text
       FROM message_content_backup b
      WHERE m.id = b.message_id`
  )
  console.log(`Restored ${result.rowCount} messages.`)
  console.log(
    'Note: vectors deleted by the forward pass are not themselves restored — the ' +
      'embedding worker regenerates them from the restored text.'
  )
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

const main = async () => {
  if (REVERT) return revert()

  if (APPLY) await ensureBackupTable()
  else console.log('DRY RUN — nothing will be written. Re-run with --apply to perform it.\n')

  let lastId = 0
  const counts = { scanned: 0, skip: 0, unembeddable: 0, rewrite: 0, vectorsDropped: 0 }
  const samples: string[] = []
  const sessionsToReaggregate = new Set<number>()
  let chromaIds: string[] = []

  const flushChroma = async () => {
    if (!APPLY || chromaIds.length === 0) return
    await deleteByIds(config.chroma.collections.messages, chromaIds)
    chromaIds = []
  }

  for (;;) {
    const { rows } = await pickBatch(lastId)
    if (rows.length === 0) break

    for (const row of rows) {
      lastId = row.id
      counts.scanned++
      const plan = planStrip(row)
      counts[plan.action]++
      if (plan.action === 'skip') continue

      // Keep a few for the operator to eyeball before approving a real run.
      if (samples.length < 12) samples.push(preview(plan))

      const dropVector = plan.dropVector && row.has_vector
      if (dropVector) counts.vectorsDropped++

      if (!APPLY) continue

      await query(
        `INSERT INTO message_content_backup (message_id, content_text, reason)
         VALUES ($1, $2, $3) ON CONFLICT (message_id) DO NOTHING`,
        [plan.id, plan.original, plan.reason]
      )
      await query(`UPDATE messages SET content_text = $1 WHERE id = $2`, [plan.stripped, plan.id])

      if (plan.action === 'unembeddable') {
        await query(
          `INSERT INTO embeddings (message_id, chroma_collection, chroma_id, embedding_model,
             dimensions, content_chars_at_embed, failure_reason, failure_detail, retry_count, updated_at)
           VALUES ($1, 'UNEMBEDDABLE', 'unembeddable-' || $1, 'none', 0, 0, 'noise', 'scaffolding-only', 0, NOW())
           ON CONFLICT (message_id, chroma_collection)
           DO UPDATE SET failure_reason = 'noise', failure_detail = 'scaffolding-only', updated_at = NOW()`,
          [plan.id]
        )
      }

      if (dropVector) {
        await query(`DELETE FROM embeddings WHERE message_id = $1 AND chroma_collection = $2`, [
          plan.id,
          config.chroma.collections.messages,
        ])
        chromaIds.push(`msg-${plan.id}`)
        sessionsToReaggregate.add(plan.sessionId)
      }
    }

    if (chromaIds.length >= 200) await flushChroma()
    console.log(
      `scanned=${counts.scanned} rewrite=${counts.rewrite} unembeddable=${counts.unembeddable} ` +
        `skip=${counts.skip} vectorsDropped=${counts.vectorsDropped}`
    )
  }

  await flushChroma()

  // A session whose messages changed has a stale summary and stale chunks;
  // clearing them lets the next aggregate pass rebuild from clean content.
  if (APPLY) {
    const sessionIds = [...sessionsToReaggregate]
    for (let i = 0; i < sessionIds.length; i += 500) {
      const slice = sessionIds.slice(i, i + 500)
      const chromaSessionIds = slice.map((id) => `session-${id}`)
      await query(
        `DELETE FROM embeddings WHERE chroma_collection = $1 AND chroma_id = ANY($2::text[])`,
        [config.chroma.collections.sessions, chromaSessionIds]
      )
      await deleteByIds(config.chroma.collections.sessions, chromaSessionIds)
      await query(`DELETE FROM session_chunks WHERE session_id = ANY($1::bigint[])`, [slice])
    }
  }

  if (samples.length > 0) {
    console.log('\nSamples:')
    for (const s of samples) console.log(s)
  }

  console.log(
    `\n${APPLY ? 'done' : 'DRY RUN — nothing written'}. scanned=${counts.scanned} ` +
      `rewrite=${counts.rewrite} unembeddable=${counts.unembeddable} skip=${counts.skip} ` +
      `vectorsDropped=${counts.vectorsDropped} sessionsReset=${sessionsToReaggregate.size}`
  )
  if (!APPLY) console.log('Re-run with --apply to perform the backfill (originals are backed up).')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => closePool())
