import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/postgres.js', () => ({ query: vi.fn() }))

const { parseGrades, renderCard } = await import('./judge.js')

const card = {
  sessionId: 42,
  title: 'title-sleepy-walrus',
  summary: 'summary-tangled-kite',
  summaryKind: 'generated' as const,
  dataClass: 'coding',
  projectPath: null,
  startedAt: null,
  chunkSummaries: [],
  messages: [{ role: 'user', text: 'message-frantic-gnome' }],
}

describe('parseGrades', () => {
  it('reads grades wrapped in prose', () => {
    expect(parseGrades('Sure: {"grades":{"C1":3,"C2":0}} done', ['C1', 'C2']).get('C1')).toBe(3)
  })

  it('rejects a missing label', () => {
    expect(() => parseGrades('{"grades":{"C1":3}}', ['C1', 'C2'])).toThrow(/C2/)
  })

  it('rejects an out-of-range grade', () => {
    expect(() => parseGrades('{"grades":{"C1":4}}', ['C1'])).toThrow(/C1/)
  })
})

describe('renderCard', () => {
  // The judge must not learn which session is the query's source.
  it('names the candidate by label, never by session id', () => {
    expect(renderCard('C1', card, [])).not.toMatch(/42/)
  })

  it('shows the excerpts', () => {
    expect(renderCard('C1', card, ['snippet-wobbly-yak'])).toMatch(/message-frantic-gnome[\s\S]*snippet-wobbly-yak/)
  })
})
