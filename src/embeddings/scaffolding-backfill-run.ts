// Performs the scaffolding backfill (issue #37) against an injected store.
//
// The decision — `planStrip` — already lives apart from the writes so it can be
// tested without a database. This module separates the *sequencing* for the
// same reason: whether the backfill is interruptible, whether the dry run tells
// the truth, and whether `--revert` actually reverts are all properties of the
// order operations happen in, and none of them are visible by reading SQL.
//
// Three invariants, each covered by a test in the sibling file:
//
//   1. A dry run performs no writes AND reports the figures the real run will
//      produce — including the session resets, which are the only step with a
//      cost the operator cannot undo cheaply.
//   2. Anything bound for deletion in Chroma is written to a journal table
//      BEFORE the Postgres row naming it is dropped. Kill the process anywhere
//      and the next run finishes the job; without the journal the vector is
//      unreachable forever, because the stripped text now plans as `skip` and
//      vector search reads Chroma without consulting `embeddings`.
//   3. Everything destroyed is backed up first — message text and session
//      chunks alike — and `--revert` restores all of it, including clearing the
//      terminal UNEMBEDDABLE rows that would otherwise leave the messages
//      permanently unsearchable after a "successful" restore.

import { planStrip, type BackfillRow, type StripPlan } from './scaffolding-backfill.js'
import { classifyNoise } from './classify.js'

export interface BackfillCandidate extends BackfillRow {
  has_vector: boolean
}

export interface QueuedVector {
  collection: string
  chromaId: string
}

export interface BackfillStore {
  ensureTables(): Promise<void>
  pickBatch(afterId: number, limit: number): Promise<BackfillCandidate[]>
  saveOriginal(plan: StripPlan): Promise<void>
  applyStripped(plan: StripPlan): Promise<void>
  markUnembeddable(messageId: number): Promise<void>
  // Writes the id to the pending-deletes journal. Must happen before the row
  // that names the vector is removed.
  queueVectorDelete(vector: QueuedVector): Promise<void>
  forgetVectorRow(messageId: number): Promise<void>
  // Deletes every journalled vector from Chroma, then clears the journal.
  // Idempotent: deleting an id twice is harmless, losing one is not.
  drainVectorDeletes(): Promise<number>
  saveSessionChunks(sessionIds: number[]): Promise<void>
  resetSessions(sessionIds: number[]): Promise<void>
}

export interface BackfillOptions {
  apply: boolean
  batchSize?: number
  // Journalled ids are drained in batches; a smaller number costs more round
  // trips, a larger one leaves more work for a re-run to redo (never to lose).
  drainEvery?: number
  sampleLimit?: number
}

export interface BackfillSummary {
  scanned: number
  skip: number
  unembeddable: number
  rewrite: number
  vectorsDropped: number
  sessionsReset: number
  // Rewrites — rows whose real content survives — whose surviving text is short
  // enough that the embedding worker will refuse it afterwards. `rewrite` alone
  // reads as "kept", and for these it is only half true: the text is kept and
  // full-text search still finds them, but the vector is dropped and never
  // comes back.
  shortAfterStrip: number
  // Husks plus short survivors: every message this run leaves unembeddable.
  unembeddableAfter: number
  // Of those, the ones that hold a vector today — the messages that are
  // findable by semantic search now and will not be afterwards.
  findabilityLost: number
  samples: StripPlan[]
}

export const runBackfill = async (
  store: BackfillStore,
  options: BackfillOptions,
  onBatch?: (summary: Omit<BackfillSummary, 'samples'>) => void
): Promise<BackfillSummary> => {
  const { apply, batchSize = 500, drainEvery = 200, sampleLimit = 12 } = options

  if (apply) {
    await store.ensureTables()
    // Finish anything a previous run was interrupted in the middle of, before
    // adding more to the pile.
    await store.drainVectorDeletes()
  }

  const counts = {
    scanned: 0,
    skip: 0,
    unembeddable: 0,
    rewrite: 0,
    vectorsDropped: 0,
    shortAfterStrip: 0,
    unembeddableAfter: 0,
    findabilityLost: 0,
  }
  const samples: StripPlan[] = []
  const sessionsToReset = new Set<number>()
  let queued = 0
  let lastId = 0

  for (;;) {
    const rows = await store.pickBatch(lastId, batchSize)
    if (rows.length === 0) break

    for (const row of rows) {
      lastId = row.id
      counts.scanned++
      const plan = planStrip(row)
      counts[plan.action]++
      if (plan.action === 'skip') continue

      if (samples.length < sampleLimit) samples.push(plan)

      // Asked of the same function the worker will ask, so the preview cannot
      // drift away from what actually happens next.
      const refusedAfterwards = classifyNoise(plan.stripped) !== null
      if (plan.action === 'rewrite' && refusedAfterwards) counts.shortAfterStrip++
      if (refusedAfterwards) {
        counts.unembeddableAfter++
        if (row.has_vector) counts.findabilityLost++
      }

      const dropVector = plan.dropVector && row.has_vector
      if (dropVector) {
        counts.vectorsDropped++
        // Counted for BOTH runs. Deciding the blast radius inside an
        // `if (apply)` is how the preview came to report `sessionsReset=0` for
        // an operation that resets 117 sessions.
        sessionsToReset.add(row.session_id)
      }

      if (!apply) continue

      await store.saveOriginal(plan)
      await store.applyStripped(plan)
      if (plan.action === 'unembeddable') await store.markUnembeddable(plan.id)

      if (dropVector) {
        await store.queueVectorDelete({ collection: 'messages', chromaId: `msg-${plan.id}` })
        await store.forgetVectorRow(plan.id)
        queued++
        if (queued >= drainEvery) {
          await store.drainVectorDeletes()
          queued = 0
        }
      }
    }

    onBatch?.({ ...counts, sessionsReset: sessionsToReset.size })
  }

  // A session whose messages changed has a stale summary and stale chunks;
  // clearing them lets the next aggregate pass rebuild from clean content. The
  // chunks are LLM output that costs real time to regenerate, so they are
  // copied aside first — nothing here is destroyed without a way back.
  if (apply && sessionsToReset.size > 0) {
    const ids = [...sessionsToReset]
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500)
      await store.saveSessionChunks(slice)
      await store.resetSessions(slice)
      await store.drainVectorDeletes()
    }
  }

  if (apply) await store.drainVectorDeletes()

  return { ...counts, sessionsReset: sessionsToReset.size, samples }
}

export interface RevertStore {
  countBackups(): Promise<number>
  countChunkBackups(): Promise<number>
  restoreText(): Promise<number>
  // Removes the UNEMBEDDABLE rows the forward pass and the embedding worker
  // wrote for backed-up messages, so the pending query can see them again.
  clearTerminalNoise(): Promise<number>
  restoreSessionChunks(): Promise<number>
}

export interface RevertSummary {
  restored: number
  requeued: number
  chunksRestored: number
  applied: boolean
}

export const runRevert = async (
  store: RevertStore,
  options: { apply: boolean }
): Promise<RevertSummary> => {
  const backups = await store.countBackups()
  const chunkBackups = await store.countChunkBackups()

  if (backups === 0 && chunkBackups === 0)
    return { restored: 0, requeued: 0, chunksRestored: 0, applied: options.apply }

  if (!options.apply)
    return {
      restored: backups,
      requeued: backups,
      chunksRestored: chunkBackups,
      applied: false,
    }

  const restored = await store.restoreText()
  // Restoring the text is not the revert. `failure_reason = 'noise'` is
  // terminal — `src/embeddings/batch.ts` only ever retries `'nan'` — so a
  // message left holding one after its text came back is invisible to semantic
  // search forever, silently, with no command that fixes it. Clearing the rows
  // is what puts the messages back in the queue.
  const requeued = await store.clearTerminalNoise()
  const chunksRestored = await store.restoreSessionChunks()

  return { restored, requeued, chunksRestored, applied: true }
}
