import { callClaude, extractJson, pool, withRetries } from './claude.js'
import { sessionCard, type SessionCard } from './corpus.js'
import { shuffled } from './metrics.js'
import { appendJsonl } from './store.js'
import type { BenchQuery, Grade, Judgment } from './types.js'

// Changing the rubric or the card changes what a grade means: bump the
// version, and the cache (keyed by it) re-judges from scratch.
export const JUDGE_PROMPT_VERSION = 'judge-v1'

export const JUDGE_SYSTEM = `You grade search results for a personal search engine over one person's past AI-assistant conversations, notes and messages.
You get a search query and several candidate conversations, each with a label. Grade every candidate for how well it serves what the person typing the query is looking for:
3 = exactly the conversation the query is after
2 = clearly relevant: substantially about what the query asks
1 = marginal: touches the topic in passing, or shares words but not the need
0 = unrelated, or junk (automated output, boilerplate, near-empty)
Grade each candidate on its own merits; several or none may deserve 3. The order of candidates means nothing.
Reply with only JSON: {"grades":{"<label>":<grade>, ...}} with one entry per label.`

const cut = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars)}...` : text)

export const renderCard = (label: string, card: SessionCard, snippets: string[]): string => {
  const lines = [`### Candidate ${label}`, `Title: ${card.title ?? '(none)'}`, `Summary: ${cut(card.summary ?? '(none)', 900)}`]
  if (card.chunkSummaries.length > 0)
    lines.push('Section summaries:', ...card.chunkSummaries.map((s) => `- ${cut(s, 300)}`))
  if (card.messages.length > 0)
    lines.push('Excerpts:', ...card.messages.map((m) => `- [${m.role}] ${cut(m.text.replace(/\s+/g, ' '), 300)}`))
  if (snippets.length > 0) lines.push('Matched text:', ...snippets.map((s) => `- ${cut(s.replace(/\s+/g, ' '), 400)}`))
  return lines.join('\n')
}

export const renderJudgePrompt = (queryText: string, cards: string[]) =>
  `Search query: ${JSON.stringify(queryText)}\n\n${cards.join('\n\n')}`

export const parseGrades = (output: string, labels: string[]): Map<string, Grade> => {
  const parsed = extractJson<{ grades?: Record<string, unknown> }>(output)
  const grades = new Map<string, Grade>()
  for (const label of labels) {
    const value = Number(parsed.grades?.[label])
    if (![0, 1, 2, 3].includes(value)) throw new Error(`judge gave no valid grade for ${label}: ${output}`)
    grades.set(label, value as Grade)
  }
  return grades
}

export type Pair = { query: BenchQuery; sessionId: number; snippets: string[] }

export type JudgeOptions = {
  model: string
  cwd: string
  out: string
  repeat?: number
  batchSize?: number
  concurrency?: number
  onBatch?: (done: number, total: number) => void
}

// Pairs are grouped by query and shuffled with a seed naming the repeat, so a
// retest sees each candidate in a different place among different neighbours.
export const judgePairs = async (pairs: Pair[], options: JudgeOptions): Promise<Judgment[]> => {
  const { model, cwd, out, repeat = 0, batchSize = 6, concurrency = 6, onBatch } = options
  const byQuery = new Map<string, Pair[]>()
  for (const p of pairs) byQuery.set(p.query.id, [...(byQuery.get(p.query.id) ?? []), p])
  const batches = [...byQuery.values()].flatMap((group) => {
    const order = shuffled(group, `${JUDGE_PROMPT_VERSION}:${group[0].query.id}:${repeat}`)
    return Array.from({ length: Math.ceil(order.length / batchSize) }, (_, i) => order.slice(i * batchSize, (i + 1) * batchSize))
  })
  let done = 0
  const judged = await pool(batches, concurrency, async (batch) => {
    const labels = batch.map((_, i) => `C${i + 1}`)
    const cards = await Promise.all(
      batch.map(async (p, i) => {
        const card = await sessionCard(p.sessionId, { messages: 4, chars: 300 })
        if (!card) throw new Error(`session ${p.sessionId} vanished`)
        return renderCard(labels[i], card, p.snippets)
      })
    )
    const grades = await withRetries(3, async () =>
      parseGrades(
        await callClaude({ model, cwd, system: JUDGE_SYSTEM, prompt: renderJudgePrompt(batch[0].query.text, cards) }),
        labels
      )
    )
    const rows: Judgment[] = batch.map((p, i) => ({
      queryId: p.query.id,
      sessionId: p.sessionId,
      grade: grades.get(labels[i])!,
      judgeModel: model,
      promptVersion: JUDGE_PROMPT_VERSION,
      repeat,
    }))
    appendJsonl(out, rows)
    onBatch?.(++done, batches.length)
    return rows
  })
  return judged.flat()
}
