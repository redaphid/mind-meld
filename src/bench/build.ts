import { callClaude, extractJson, pool, withRetries } from './claude.js'
import {
  appearsVerbatim,
  automatedLike,
  candidateSessions,
  corpusStats,
  realSearches,
  sessionCard,
  type SessionCard,
} from './corpus.js'
import { JUDGE_PROMPT_VERSION, judgePairs } from './judge.js'
import type { Searcher } from './systems.js'
import { sharedContentWords } from './lexical.js'
import { mulberry32, seedOf } from './metrics.js'
import { existsSync } from 'node:fs'
import { appendJsonl, benchFiles, readJson, readJsonl, writeJson } from './store.js'
import { STRATA, type BenchQuery, type Manifest, type Stratum } from './types.js'

const WRITER_SYSTEM = `You help build a test set for a personal search engine over one person's past conversations with AI assistants, plus their notes and messages. You are shown one past conversation. Reply with only JSON.`

const SKIP = `If this conversation is not something anyone would ever search for (automated output, a near-empty exchange, pure boilerplate), reply {"searchable": false, "query": ""}.`

const ASK: Record<'natural' | 'paraphrase' | 'keyword', string> = {
  natural: `Write the search query its owner would type months from now to find this conversation again, the way a person types into a search box: usually 3 to 10 words, no quotes, no ids. ${SKIP} Otherwise reply {"searchable": true, "query": "..."}.`,
  paraphrase: `Write the search query its owner would type months from now to find this conversation again, usually 4 to 10 words, describing what it was about WITHOUT reusing its words: use synonyms or describe the purpose, so a keyword search over the text would not find it. Do not use any word, or any form of a word, that appears in the text shown. ${SKIP} Otherwise reply {"searchable": true, "query": "..."}.`,
  keyword: `Pick one exact identifier, error message fragment, file name, command or function name that appears verbatim in the text shown and that a person might paste into a search box to find this conversation again. Copy it character for character, 4 to 80 characters. Prefer a distinctive string over common words. ${SKIP} Otherwise reply {"searchable": true, "query": "<the exact string>"}.`,
}

const cut = (text: string, chars: number) => (text.length > chars ? text.slice(0, chars) : text)

const shownText = (card: SessionCard) =>
  [
    `Title: ${card.title ?? '(none)'}`,
    `Summary: ${cut(card.summary ?? '(none)', 1500)}`,
    ...card.chunkSummaries.map((s) => `Section: ${cut(s, 400)}`),
    ...card.messages.map((m) => `[${m.role}] ${m.text}`),
  ].join('\n')

type Written = { query: string; attempts: number } | { discarded: string }

const writeQuery = async (
  kind: 'natural' | 'paraphrase' | 'keyword',
  card: SessionCard,
  cwd: string
): Promise<Written> => {
  const shown = shownText(card)
  let feedback = ''
  for (let attempt = 1; attempt <= 4; attempt++) {
    const reply = await withRetries(3, async () =>
      extractJson<{ searchable?: boolean; query?: string }>(
        await callClaude({ model: 'haiku', cwd, system: WRITER_SYSTEM, prompt: `${shown}\n\n---\n${ASK[kind]}${feedback}` })
      )
    )
    const text = (reply.query ?? '').trim()
    if (reply.searchable === false) return { discarded: 'not searchable' }
    if (!text || text.length > 200) return { discarded: 'empty or overlong' }
    if (kind === 'paraphrase') {
      const shared = sharedContentWords(text, shown)
      if (shared.length === 0) return { query: text, attempts: attempt }
      feedback = `\n\nYour previous query reused these words from the text: ${shared.join(', ')}. Write a new one avoiding them and every other word in the text.`
      continue
    }
    if (kind === 'keyword') {
      if (text.length >= 4 && (await appearsVerbatim(card.sessionId, text))) return { query: text, attempts: attempt }
      feedback = `\n\nYour previous answer does not appear verbatim in the conversation. Copy an exact string from the text shown.`
      continue
    }
    return { query: text, attempts: attempt }
  }
  return { discarded: kind === 'paraphrase' ? 'kept reusing words' : 'not verbatim' }
}

type Plan = { stratum: Stratum; kind: 'natural' | 'paraphrase' | 'keyword'; dataClass: string[]; target: number }

// Absent topics are the harder half of noanswer (raw best-match cosine
// separates gibberish from real queries almost perfectly), so they get more.
export const TARGETS = { natural: 35, paraphrase: 35, keyword: 25, crossclass: 20, gibberish: 10, absentTopic: 20 }

const PLANS: Plan[] = [
  { stratum: 'natural', kind: 'natural', dataClass: ['coding'], target: TARGETS.natural },
  { stratum: 'paraphrase', kind: 'paraphrase', dataClass: ['coding'], target: TARGETS.paraphrase },
  { stratum: 'keyword', kind: 'keyword', dataClass: ['coding'], target: TARGETS.keyword },
  { stratum: 'crossclass', kind: 'natural', dataClass: ['*'], target: TARGETS.crossclass },
]

const buildFromSessions = async (
  plan: Plan,
  sessions: number[],
  cwd: string,
  log: (row: unknown) => void
): Promise<BenchQuery[]> => {
  const out: BenchQuery[] = []
  for (let start = 0; start < sessions.length && out.length < plan.target; start += 12) {
    const wave = await pool(sessions.slice(start, start + 12), 6, async (sessionId): Promise<BenchQuery | null> => {
      const card = await sessionCard(sessionId, { messages: 8, chars: 500 })
      if (!card) return null
      const written = await writeQuery(plan.kind, card, cwd)
      log({ stratum: plan.stratum, sessionId, ...('discarded' in written ? written : { attempts: written.attempts }) })
      if ('discarded' in written) return null
      return {
        id: `${plan.stratum}-${sessionId}`,
        stratum: plan.stratum,
        text: written.query,
        dataClass: plan.dataClass,
        goldSessionIds: [sessionId],
        goldSummaryKind: card.summaryKind,
        goldProjectPath: card.projectPath,
        sourceNote: `haiku-written from session ${sessionId} (${card.dataClass}), attempt ${written.attempts}`,
        replay: {},
        notAfter: null,
        excludeSessionIds: [],
      }
    })
    out.push(...wave.filter((q): q is BenchQuery => q !== null))
  }
  return out.slice(0, plan.target)
}

const SYLLABLES = ['zor', 'quil', 'vex', 'pran', 'dulo', 'skev', 'mirth', 'oblu', 'trak', 'fenwi', 'gash', 'yole']

const gibberish = (seed: string, n: number): string[] => {
  const random = mulberry32(seedOf(seed))
  const word = () =>
    Array.from({ length: 2 + Math.floor(random() * 2) }, () => SYLLABLES[Math.floor(random() * SYLLABLES.length)]).join('')
  return Array.from({ length: n }, () => Array.from({ length: 2 + Math.floor(random() * 3) }, word).join(' '))
}

const ABSENT_ASK = `List 60 search queries that someone who uses AI assistants for software work and for personal life might plausibly type, each about a specific niche topic (a particular hobby, sport, cuisine, legal or medical question, obscure technology, historical event), 3 to 8 words each. Make them varied and specific. Reply {"queries": ["...", ...]}.`

// No-answer queries: gibberish, and plausible topics verified absent.
// Absent means full text finds nothing, and the judge grades every top
// semantic hit at most marginal.
export type NoAnswerSearchers = { text: Searcher; semantic: Searcher }

const buildNoAnswer = async (
  seed: string,
  cwd: string,
  buildDir: string,
  search: NoAnswerSearchers,
  log: (row: unknown) => void
) => {
  const quota = { gibberish: TARGETS.gibberish, 'absent-topic': TARGETS.absentTopic }
  const candidates = [
    ...gibberish(seed, quota.gibberish).map((text) => ({ text, kind: 'gibberish' })),
    ...(
      await withRetries(3, async () =>
        extractJson<{ queries: string[] }>(await callClaude({ model: 'haiku', cwd, system: WRITER_SYSTEM, prompt: ABSENT_ASK }))
      )
    ).queries.map((text) => ({ text, kind: 'absent-topic' })),
  ]
  const kept: BenchQuery[] = []
  const byKind = { gibberish: 0, 'absent-topic': 0 }
  for (const [i, c] of candidates.entries()) {
    if (byKind[c.kind as keyof typeof byKind] >= quota[c.kind as keyof typeof quota]) continue
    const query: BenchQuery = {
      id: `noanswer-${i}`,
      stratum: 'noanswer',
      text: c.text,
      dataClass: ['*'],
      goldSessionIds: [],
      goldSummaryKind: null,
      goldProjectPath: null,
      sourceNote: `${c.kind}; verified: no full-text hit, top-5 semantic hits judged <= 1`,
      replay: {},
      notAfter: null,
      excludeSessionIds: [],
    }
    const text = await search.text(query)
    if (text.results.length > 0) {
      log({ stratum: 'noanswer', candidate: i, discarded: 'full-text hit' })
      continue
    }
    const semantic = await search.semantic(query)
    if (semantic.degraded) throw new Error(`semantic search degraded while verifying no-answer queries: ${semantic.degraded}`)
    const grades = await judgePairs(
      semantic.results.slice(0, 5).map((r) => ({ query, sessionId: r.sessionId, snippets: r.snippet ? [r.snippet] : [] })),
      { model: 'haiku', cwd, out: `${buildDir}/noanswer-checks.jsonl` }
    )
    if (grades.some((g) => g.grade >= 2)) {
      log({ stratum: 'noanswer', candidate: i, discarded: 'semantic hit judged relevant' })
      continue
    }
    byKind[c.kind as keyof typeof byKind]++
    kept.push(query)
  }
  return kept
}

const buildReal = async (snapshot: number): Promise<BenchQuery[]> => {
  const out: BenchQuery[] = []
  const searches = await realSearches()
  const automated = await automatedLike([...new Set(searches.flatMap((s) => s.opened))])
  for (const s of searches) {
    if (s.opened.some((id) => id > snapshot || automated.has(id))) continue
    const card = await sessionCard(s.opened[0], { messages: 0 })
    if (!card) continue
    const rank = s.listed.indexOf(s.opened[0]) + 1
    out.push({
        id: `real-${s.toolUseId}`,
        stratum: 'real',
        text: s.text,
        dataClass: s.dataClass.length > 0 ? s.dataClass : ['coding'],
        goldSessionIds: s.opened,
        goldSummaryKind: card.summaryKind,
        goldProjectPath: card.projectPath,
        sourceNote: `agent search ${s.at.toISOString()} mode=${s.originalMode}; weak gold = listed sessions opened next (first at original rank ${rank})`,
        replay: s.replay,
        notAfter: s.at.toISOString(),
        excludeSessionIds: [s.transcriptSessionId],
    })
  }
  return out
}

export type BuildOptions = {
  dir: string
  seed: string
  excludePathPatterns: string[]
  // The system under test, for checking that no-answer topics are absent.
  search: NoAnswerSearchers
  strata?: Stratum[]
}

// Idempotent: a stratum already in queries.jsonl is skipped, and the first
// run's snapshot is kept, so a rerun after a crash finishes the set instead of
// redrawing it against a corpus that has grown since.
export const buildBench = async ({ dir, seed, excludePathPatterns, search, strata }: BuildOptions) => {
  const files = benchFiles(dir)
  const existing = readJsonl<BenchQuery>(files.queries)
  const previous = existsSync(files.manifest) ? readJson<Manifest>(files.manifest) : null
  if (previous?.frozenAt) throw new Error(`the bench in ${dir} is frozen; build a new one in another directory`)
  const corpus = previous?.corpus ?? (await corpusStats())
  const snapshot = previous?.snapshotMaxSessionId ?? corpus.max_session_id
  const log = (row: unknown) => appendJsonl(`${files.build}/writer-log.jsonl`, [row])
  const requested = (s: Stratum) => !strata || strata.includes(s)
  const have = (s: Stratum) => existing.filter((q) => q.stratum === s).length
  const want = (s: Stratum) => requested(s) && have(s) === 0
  const used = new Set(existing.flatMap((q) => q.goldSessionIds))
  const queries: BenchQuery[] = []
  // Each stratum is written as soon as it is built, so a crash costs one.
  const keep = (built: BenchQuery[]) => {
    appendJsonl(files.queries, built)
    queries.push(...built)
  }

  const coding = await candidateSessions(['coding'], seed, snapshot, 400)
  const personal = await candidateSessions(['personal', 'notes'], seed, snapshot, 120)
  // Disjoint sources: coding candidates are dealt round-robin to the three
  // coding strata, so no session is the gold of two generated queries.
  const dealt = (index: number) => coding.filter((_, i) => i % 3 === index)
  // A generated stratum short of its target (a query removed before freezing)
  // is topped up from sessions no query uses yet.
  for (const [index, plan] of PLANS.entries()) {
    const missing = plan.target - have(plan.stratum)
    if (!requested(plan.stratum) || missing <= 0) continue
    const sessions = (plan.stratum === 'crossclass' ? personal : dealt(index)).filter((id) => !used.has(id))
    keep(await buildFromSessions({ ...plan, target: missing }, sessions, files.judgeCwd, log))
  }
  if (want('noanswer')) keep(await buildNoAnswer(seed, files.judgeCwd, files.build, search, log))
  if (want('real')) keep(await buildReal(snapshot))

  const manifest: Manifest = previous ?? {
    frozenAt: null,
    seed,
    snapshotMaxSessionId: snapshot,
    promptVersion: JUDGE_PROMPT_VERSION,
    judgeModel: 'haiku',
    poolSystems: ['text', 'semantic', 'hybrid'],
    excludePathPatterns,
    counts: {},
    corpus,
    harnessSha: null,
    queriesSha256: null,
    notes: [],
  }
  writeJson(files.manifest, manifest)
  const all = [...existing, ...queries]
  return { snapshot, counts: Object.fromEntries(STRATA.map((s) => [s, all.filter((q) => q.stratum === s).length])) }
}
