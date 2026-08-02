import { describe, it, expect } from 'vitest'
import { runBackfill, runRevert, type BackfillStore, type RevertStore } from './scaffolding-backfill-run.js'
import type { BackfillCandidate } from './scaffolding-backfill-run.js'

// A store that records every call in order, so the tests can assert not just
// *what* the run does but *when* — the interruption safety of this script is
// entirely a property of ordering.
const fakeStore = (rows: BackfillCandidate[], opts: { failOn?: string } = {}) => {
  const calls: string[] = []
  const journal: string[] = []
  const chromaDeleted: string[] = []
  const rewritten: number[] = []
  const backedUp: number[] = []
  const unembeddable: number[] = []
  const chunkBackups: number[] = []
  const sessionsReset: number[] = []
  const vectorRowsDropped: number[] = []
  let served = false

  const record = (name: string) => {
    calls.push(name)
    if (opts.failOn !== undefined && name === opts.failOn) throw new Error('simulated crash')
  }

  const store: BackfillStore = {
    async ensureTables() {
      record('ensureTables')
    },
    async pickBatch() {
      record('pickBatch')
      if (served) return []
      served = true
      return rows
    },
    async saveOriginal(plan) {
      record(`saveOriginal:${plan.id}`)
      backedUp.push(plan.id)
    },
    async applyStripped(plan) {
      record(`applyStripped:${plan.id}`)
      rewritten.push(plan.id)
    },
    async markUnembeddable(id) {
      record(`markUnembeddable:${id}`)
      unembeddable.push(id)
    },
    async queueVectorDelete(v) {
      record(`queueVectorDelete:${v.chromaId}`)
      journal.push(v.chromaId)
    },
    async forgetVectorRow(id) {
      record(`forgetVectorRow:${id}`)
      vectorRowsDropped.push(id)
    },
    async drainVectorDeletes() {
      record('drainVectorDeletes')
      const drained = journal.length
      chromaDeleted.push(...journal)
      // The contract the real store implements: draining removes the vector
      // AND any row still naming it, so an interruption between the two cannot
      // leave a row pointing at a vector that is gone.
      for (const id of journal) {
        const message = /^msg-(\d+)$/.exec(id)
        if (message) vectorRowsDropped.push(Number(message[1]))
      }
      journal.length = 0
      return drained
    },
    async saveSessionChunks(ids) {
      record(`saveSessionChunks:${ids.join(',')}`)
      chunkBackups.push(...ids)
    },
    async resetSessions(ids) {
      record(`resetSessions:${ids.join(',')}`)
      // Session and chunk vectors go through the same journal as message
      // vectors — everything Chroma-bound is written down before it is dropped.
      for (const id of ids) journal.push(`session-${id}`)
      sessionsReset.push(...ids)
    },
  }

  return {
    store,
    calls,
    journal,
    chromaDeleted,
    rewritten,
    backedUp,
    unembeddable,
    chunkBackups,
    sessionsReset,
    vectorRowsDropped,
  }
}

const husk = (id: number, session: number): BackfillCandidate => ({
  id,
  session_id: session,
  content_text: '<command-message>vj</command-message>\n<command-name>/vj</command-name>',
  has_vector: true,
})

const material = (id: number, session: number): BackfillCandidate => ({
  id,
  session_id: session,
  content_text:
    '<system-reminder>a long hook injection that dominates the message body and then some more of it</system-reminder>\n' +
    'the actual question the user asked about the embedding backlog',
  has_vector: true,
})

const untouched = (id: number, session: number): BackfillCandidate => ({
  id,
  session_id: session,
  content_text: 'ordinary prose with no scaffolding in it at all',
  has_vector: true,
})

describe('runBackfill: the dry run reports the real blast radius (review F2)', () => {
  it('counts the sessions a real run would reset', async () => {
    // The number the operator approves has to be the number that happens. The
    // session reset deletes session_chunks, which is the one step whose cost is
    // LLM summarization time, so understating it as 0 is the worst possible
    // place to be wrong.
    const f = fakeStore([husk(1, 10), material(2, 11), untouched(3, 12)])
    const summary = await runBackfill(f.store, { apply: false })

    expect(summary.sessionsReset).toBe(2)
    expect(summary.scanned).toBe(3)
    expect(summary.skip).toBe(1)
    expect(summary.vectorsDropped).toBe(2)
  })

  it('writes absolutely nothing in a dry run', async () => {
    const f = fakeStore([husk(1, 10), material(2, 11)])
    await runBackfill(f.store, { apply: false })

    expect(f.backedUp).toEqual([])
    expect(f.rewritten).toEqual([])
    expect(f.unembeddable).toEqual([])
    expect(f.chromaDeleted).toEqual([])
    expect(f.sessionsReset).toEqual([])
    expect(f.calls.filter((c) => c !== 'pickBatch')).toEqual([])
  })

  it('reports the same figures a real run produces', async () => {
    const rows = [husk(1, 10), material(2, 11), untouched(3, 12)]
    const dry = await runBackfill(fakeStore(rows).store, { apply: false })
    const wet = await runBackfill(fakeStore(rows).store, { apply: true })

    expect({ ...wet, samples: [] }).toEqual({ ...dry, samples: [] })
  })
})

const shortSurvivor = (id: number, session: number): BackfillCandidate => ({
  id,
  session_id: session,
  // Real content, and it survives the strip — but only 28 characters of it, so
  // the embedding worker's 50-character floor discards it afterwards.
  content_text:
    '<system-reminder>a long hook injection that dominates the message body and then some more of it</system-reminder>\n' +
    '<command-name>/ask</command-name>\n<command-args>why is the queue stuck?</command-args>',
  has_vector: true,
})

describe('runBackfill: the preview names what becomes unsearchable (review F4)', () => {
  it('counts rewrites whose stripped text falls under the embedding floor', async () => {
    // These are the rows the plan labels "real content survives". It does
    // survive — in full-text search. But the vector is dropped, the message
    // requeues, the worker measures 28 characters and marks it terminal noise.
    // Framing the loss as only the 269 husks understates it by more than
    // double, and the operator approves the number that is printed.
    const f = fakeStore([husk(1, 10), material(2, 11), shortSurvivor(3, 12)])
    const summary = await runBackfill(f.store, { apply: false })

    expect(summary.rewrite).toBe(2)
    expect(summary.shortAfterStrip).toBe(1)
    // Husks plus short survivors: everything the worker will refuse to embed.
    expect(summary.unembeddableAfter).toBe(2)
  })

  it('counts only the ones that are findable today as findability lost', async () => {
    const f = fakeStore([
      husk(1, 10),
      { ...shortSurvivor(3, 12), has_vector: false },
      shortSurvivor(4, 13),
    ])
    const summary = await runBackfill(f.store, { apply: false })

    expect(summary.unembeddableAfter).toBe(3)
    expect(summary.findabilityLost).toBe(2)
  })
})

describe('runBackfill: an interrupted run can be finished (review F3)', () => {
  it('records a vector in the journal before dropping its row', async () => {
    // Reverse this order and a crash in the window leaves a live vector with no
    // row pointing at it. A re-run cannot find it — the text is already
    // stripped, so it plans as `skip` — and vector search reads Chroma without
    // consulting the embeddings table, so the orphan keeps scoring.
    const f = fakeStore([husk(1, 10)])
    await runBackfill(f.store, { apply: true })

    const queued = f.calls.indexOf('queueVectorDelete:msg-1')
    const dropped = f.calls.indexOf('forgetVectorRow:1')
    expect(queued).toBeGreaterThanOrEqual(0)
    expect(dropped).toBeGreaterThan(queued)
  })

  it('backs a message up before it rewrites it', async () => {
    const f = fakeStore([material(2, 11)])
    await runBackfill(f.store, { apply: true })
    expect(f.calls.indexOf('saveOriginal:2')).toBeLessThan(f.calls.indexOf('applyStripped:2'))
  })

  it('drains a previous run journal before doing anything else', async () => {
    const f = fakeStore([husk(1, 10)])
    await runBackfill(f.store, { apply: true })
    expect(f.calls.indexOf('drainVectorDeletes')).toBeLessThan(f.calls.indexOf('pickBatch'))
  })

  it('leaves no Chroma vector unaccounted for when the run crashes mid-batch', async () => {
    // Crash right after the journal insert. The vector is still live in Chroma
    // and its row is gone or going — the journal is the only thing that can
    // still name it.
    const crashing = fakeStore([husk(1, 10)], { failOn: 'forgetVectorRow:1' })
    await expect(runBackfill(crashing.store, { apply: true })).rejects.toThrow('simulated crash')
    expect(crashing.journal).toContain('msg-1')
  })

  it('finishes a crashed row on the next run, vector and row alike', async () => {
    // Crash between the journal write and the row delete. The re-run cannot see
    // the message any more — its text is already stripped, so it plans as
    // `skip` — but the journal still names the vector, and draining it removes
    // both the vector and the row that would otherwise read as "embedded".
    const crashed = fakeStore([husk(1, 10)], { failOn: 'forgetVectorRow:1' })
    await expect(runBackfill(crashed.store, { apply: true })).rejects.toThrow()
    expect(crashed.journal).toEqual(['msg-1'])

    await crashed.store.drainVectorDeletes()
    expect(crashed.chromaDeleted).toEqual(['msg-1'])
    expect(crashed.vectorRowsDropped).toEqual([1])
    expect(crashed.journal).toEqual([])
  })

  it('backs up session chunks before deleting them', async () => {
    const f = fakeStore([material(2, 11)])
    await runBackfill(f.store, { apply: true })
    expect(f.calls.indexOf('saveSessionChunks:11')).toBeLessThan(f.calls.indexOf('resetSessions:11'))
    expect(f.chunkBackups).toEqual([11])
  })

  it('deletes session and chunk vectors through the journal too', async () => {
    const f = fakeStore([material(2, 11)])
    await runBackfill(f.store, { apply: true })
    expect(f.chromaDeleted).toContain('session-11')
    expect(f.journal).toEqual([])
  })
})

const fakeRevertStore = (counts = { backups: 5, chunkBackups: 3 }) => {
  const calls: string[] = []
  const store: RevertStore = {
    async countBackups() {
      calls.push('countBackups')
      return counts.backups
    },
    async countChunkBackups() {
      calls.push('countChunkBackups')
      return counts.chunkBackups
    },
    async restoreText() {
      calls.push('restoreText')
      return counts.backups
    },
    async clearTerminalNoise() {
      calls.push('clearTerminalNoise')
      return counts.backups
    },
    async restoreSessionChunks() {
      calls.push('restoreSessionChunks')
      return counts.chunkBackups
    },
  }
  return { store, calls }
}

describe('runRevert: a revert actually reverts (review F1)', () => {
  it('clears the terminal UNEMBEDDABLE rows so the messages requeue', async () => {
    // Restoring the text alone leaves an UNEMBEDDABLE/noise row in place, and
    // `noise` has no healing path — the message is permanently invisible to
    // semantic search with no error and no log line. Clearing the row is the
    // difference between a revert and a lie.
    const f = fakeRevertStore()
    const summary = await runRevert(f.store, { apply: true })

    expect(f.calls).toContain('clearTerminalNoise')
    expect(summary.requeued).toBe(5)
  })

  it('restores the session chunks the forward pass deleted', async () => {
    const f = fakeRevertStore()
    const summary = await runRevert(f.store, { apply: true })

    expect(f.calls).toContain('restoreSessionChunks')
    expect(summary.chunksRestored).toBe(3)
  })

  it('previews the same figures without writing', async () => {
    const f = fakeRevertStore()
    const summary = await runRevert(f.store, { apply: false })

    expect(summary.restored).toBe(5)
    expect(summary.chunksRestored).toBe(3)
    expect(f.calls).not.toContain('restoreText')
    expect(f.calls).not.toContain('clearTerminalNoise')
    expect(f.calls).not.toContain('restoreSessionChunks')
  })

  it('does nothing when there is no backup to revert to', async () => {
    const f = fakeRevertStore({ backups: 0, chunkBackups: 0 })
    const summary = await runRevert(f.store, { apply: true })

    expect(summary.restored).toBe(0)
    expect(f.calls).not.toContain('restoreText')
  })
})
