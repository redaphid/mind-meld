import { describe, it, expect } from 'vitest'
import { resolveTitle, notWarmup } from './title.js'

describe('resolveTitle', () => {
  const transcript = '[USER]: can you look at why the sync worker keeps restarting\n\n---\n\n[ASSISTANT]: Checking the logs.'

  it('titles a verbatim transcript with its generated title, not its first raw line', () => {
    expect(resolveTitle({ title: null, summary: transcript, generated_title: 'Sync worker restart loop diagnosed' })).toEqual({
      title: 'Sync worker restart loop diagnosed',
      titleSource: 'generated',
    })
  })

  it('ignores a generated title once the session has a real summary', () => {
    const summary = 'Diagnosed the sync worker restart loop. It was the healthcheck.'
    expect(resolveTitle({ title: null, summary, generated_title: 'Stale generated title' })).toEqual({
      title: 'Diagnosed the sync worker restart loop.',
      titleSource: 'summary',
    })
  })

  it('keeps a source title over a generated one', () => {
    expect(resolveTitle({ title: 'Thread with Sam', summary: transcript, generated_title: 'Generated' }).titleSource).toBe('source')
  })

  it('falls back to the transcript line when no title was generated', () => {
    expect(resolveTitle({ title: null, summary: transcript, generated_title: null }).titleSource).toBe('summary')
  })

  it('uses a stored title when the source supplied a real one', () => {
    expect(resolveTitle({ title: 'SMS with Alex', summary: 'They discussed dinner plans.', generated_title: null })).toEqual({
      title: 'SMS with Alex',
      titleSource: 'source',
    })
  })

  it('derives from the summary when there is no stored title', () => {
    expect(resolveTitle({ title: null, summary: 'Debugged the FTS ranking query.\n\nDetails follow.', generated_title: null })).toEqual({
      title: 'Debugged the FTS ranking query.',
      titleSource: 'summary',
    })
  })

  it('takes the first sentence when the summary opens with a long paragraph', () => {
    const summary =
      'Set up Dozzle and ntfy for container monitoring. The alerts were then routed through a webhook.'
    expect(resolveTitle({ title: null, summary, generated_title: null })).toEqual({
      title: 'Set up Dozzle and ntfy for container monitoring.',
      titleSource: 'summary',
    })
  })

  it('does not split on an abbreviation or a decimal', () => {
    expect(resolveTitle({ title: null, summary: 'Upgraded to v1.13.0 of the indexer.', generated_title: null })).toEqual({
      title: 'Upgraded to v1.13.0 of the indexer.',
      titleSource: 'summary',
    })
  })

  it('skips leading blank lines and markdown heading markers', () => {
    expect(resolveTitle({ title: null, summary: '\n\n## Summary\nFixed the parent-session linkage.', generated_title: null })).toEqual({
      title: 'Summary',
      titleSource: 'summary',
    })
  })

  it('returns no title rather than a guess when there is neither', () => {
    expect(resolveTitle({ title: null, summary: null, generated_title: null })).toEqual({ title: null, titleSource: 'none' })
  })

  it('treats a whitespace-only stored title as absent', () => {
    expect(resolveTitle({ title: '   \n ', summary: null, generated_title: null })).toEqual({ title: null, titleSource: 'none' })
  })

  it('treats a whitespace-only summary as absent', () => {
    expect(resolveTitle({ title: null, summary: '  \n\n ', generated_title: null })).toEqual({ title: null, titleSource: 'none' })
  })

  it('never cuts a word in half — the derived title ends on a sentence or a line', () => {
    // The defect this replaces produced titles cut mid-word at exactly 200 chars.
    const summary = `${'word '.repeat(80)}end of it all.`
    const { title } = resolveTitle({ title: null, summary, generated_title: null })
    expect(title).toBe(summary.trim())
  })

  it('keeps a stored title even when it is long, since the source chose it', () => {
    const long = 'A deliberately long but genuine title from an upstream source that happens to run on'
    expect(resolveTitle({ title: long, summary: 'Something else.', generated_title: null })).toEqual({
      title: long,
      titleSource: 'source',
    })
  })
})

// Once titles can be NULL (#95), `title != 'Warmup'` stops being a filter and
// becomes a trap: NULL != 'Warmup' is NULL, not true, so every untitled session
// silently drops out of the summarization batch, the centroid batch and the
// health counts — the exact sessions that most need summarizing.
describe('notWarmup', () => {
  it('is NULL-safe, so an untitled session is not silently excluded', () => {
    expect(notWarmup('s')).toBe("s.title IS DISTINCT FROM 'Warmup'")
    expect(notWarmup()).toBe("title IS DISTINCT FROM 'Warmup'")
  })

  it('never emits a plain inequality', () => {
    expect(notWarmup('s')).not.toContain('!=')
    expect(notWarmup('s')).not.toContain('<>')
  })
})
