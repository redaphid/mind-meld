import { describe, it, expect } from 'vitest'
import { planStrip } from './scaffolding-backfill.js'

const row = (id: number, content_text: string) => ({ id, session_id: 1, content_text })

describe('planStrip: deciding what to do with an already-stored message (issue #37)', () => {
  it('marks a wrapper-only message unembeddable and drops its vector', () => {
    const plan = planStrip(row(1, '<command-message>vj</command-message>\n<command-name>/vj</command-name>'))
    expect(plan).toMatchObject({
      action: 'unembeddable',
      stripped: '/vj',
      dropVector: true,
      reason: 'scaffolding-only',
    })
  })

  it('marks a reminder-only message unembeddable', () => {
    const plan = planStrip(row(2, '<system-reminder>the file is empty</system-reminder>'))
    expect(plan).toMatchObject({ action: 'unembeddable', stripped: '', dropVector: true })
  })

  it('rewrites a message whose payload survives, and re-embeds when the change is material', () => {
    // Wrapper is a large fraction of this message, so the stored vector was
    // computed mostly on markup and cannot be trusted.
    const plan = planStrip(row(3, '<command-name>/ask</command-name>\n<command-args>why is sync slow</command-args>'))
    expect(plan).toMatchObject({
      action: 'rewrite',
      stripped: '/ask\nwhy is sync slow',
      dropVector: true,
    })
  })

  it('keeps the vector when the strip barely changed a long message', () => {
    // A small reminder inside a long human message: the embedding is still
    // essentially correct, and re-embedding it would spend backlog for nothing.
    const body = 'a genuine long explanation. '.repeat(80)
    const plan = planStrip(row(4, `${body}<system-reminder>tiny</system-reminder>`))
    expect(plan.action).toBe('rewrite')
    expect(plan.dropVector).toBe(false)
  })

  it('leaves a message with no scaffolding entirely alone', () => {
    const plan = planStrip(row(5, 'just a normal question about the sync'))
    expect(plan.action).toBe('skip')
  })

  it('never shortens real content', () => {
    // The no-truncation line: everything removed must be markup. What is left
    // is a subsequence of the original, and the payload survives verbatim.
    const payload = 'float sdSphere( vec3 p, float s ) { return length(p)-s; }'
    const plan = planStrip(row(6, `<command-name>/vibej</command-name>\n<command-args>${payload}</command-args>`))
    expect(plan.stripped).toContain(payload)
  })
})
