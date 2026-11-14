import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/postgres.js', () => ({ query: vi.fn() }))
vi.mock('../db/chroma.js', () => ({}))

const { judgePairs, parseGrades, renderCard } = await import('./judge.js')
const { ModelRefusal } = await import('./claude.js')

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

describe('judgePairs', () => {
  const query = { id: 'query-id-soggy-lantern', text: 'query-text-rusty-cello' } as Parameters<typeof judgePairs>[0][number]['query']
  const pairs = [41, 42, 43].map((sessionId) => ({ query, sessionId, snippets: [] }))
  const cardFor = async (sessionId: number) => ({ ...card, sessionId, title: `title-${sessionId}` })
  // Refuses any prompt that shows session 42's card; grades every other label 2.
  const call = vi.fn(async ({ prompt }: { prompt: string }) => {
    if (prompt.includes('title-42')) throw new ModelRefusal('refused')
    const labels = [...prompt.matchAll(/### Candidate (C\d+)/g)].map((m) => m[1])
    return JSON.stringify({ grades: Object.fromEntries(labels.map((l) => [l, 2])) })
  })

  it('grades the rest of a batch one card refused, and reports the refused pair', async () => {
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'judge-')), 'judgments.jsonl')
    const refused: number[] = []
    const judged = await judgePairs(pairs, { model: 'haiku', cwd: 'unused', out, call, card: cardFor, onRefused: (p) => refused.push(p.sessionId) })
    expect(judged.map((j) => j.sessionId).sort()).toEqual([41, 43])
    expect(refused).toEqual([42])
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(2)
  })
})
