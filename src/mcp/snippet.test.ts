import { describe, it, expect } from 'vitest'
import { buildSnippet, buildExcerpt, SNIPPET_MAX_CHARS, EXCERPT_MAX_CHARS } from './snippet.js'

describe('buildSnippet', () => {
  it('prefers the ts_headline window when query terms highlighted a region', () => {
    const raw = 'A long message that wanders for a while before it ever mentions the topic at hand.'
    const headline = 'mentions the topic at hand'
    expect(buildSnippet(raw, headline)).toBe('mentions the topic at hand')
  })

  it('falls back to the first sentence of raw text for semantic-only hits', () => {
    const raw = 'We disabled flash attention. Then bge-m3 stopped producing NaN. Backfill resumed.'
    expect(buildSnippet(raw, null)).toBe('We disabled flash attention.')
  })

  it('treats an empty/whitespace headline as no headline', () => {
    const raw = 'The chunk summary explains the debugging arc.'
    expect(buildSnippet(raw, '   ')).toBe('The chunk summary explains the debugging arc.')
  })

  it('collapses internal whitespace to a single line', () => {
    const raw = 'line one\n\n  line   two\ttab'
    expect(buildSnippet(raw, raw)).toBe('line one line two tab')
  })

  it('caps long snippets at the max with an ellipsis', () => {
    const long = 'x'.repeat(400)
    const snippet = buildSnippet(long, long)!
    expect(snippet.length).toBe(SNIPPET_MAX_CHARS)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('returns null when there is nothing to show', () => {
    expect(buildSnippet(null, null)).toBeNull()
    expect(buildSnippet('   ', '')).toBeNull()
  })

  it('returns the whole text as the sentence when no terminator exists', () => {
    expect(buildSnippet('no punctuation here just words', null)).toBe(
      'no punctuation here just words'
    )
  })
})

describe('buildExcerpt (#4)', () => {
  it('keeps a full multi-sentence lead, unlike the one-sentence snippet', () => {
    const raw = 'We disabled flash attention. Then bge-m3 stopped producing NaN. Backfill resumed.'
    expect(buildExcerpt(raw, null)).toBe(raw)
  })

  it('prefers a query-highlighted headline when present', () => {
    expect(buildExcerpt('long raw text', 'highlighted region')).toBe('highlighted region')
  })

  it('caps at the excerpt max (longer than a snippet)', () => {
    const long = 'x'.repeat(800)
    const excerpt = buildExcerpt(long, null)!
    expect(excerpt.length).toBe(EXCERPT_MAX_CHARS)
    expect(EXCERPT_MAX_CHARS).toBeGreaterThan(SNIPPET_MAX_CHARS)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('returns null when there is nothing to excerpt', () => {
    expect(buildExcerpt(null, null)).toBeNull()
    expect(buildExcerpt('  ', '')).toBeNull()
  })
})
