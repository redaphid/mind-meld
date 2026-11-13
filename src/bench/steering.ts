import { existsSync } from 'node:fs'
import path from 'node:path'
import { query } from '../db/postgres.js'
import { USELESS_TAG } from '../mcp/noise.js'
import { callClaude, extractJson, withRetries } from './claude.js'
import { judgePairs } from './judge.js'
import { shuffled } from './metrics.js'
import { indexJudgments } from './score.js'
import { reportSteering, scoreSteering, STEER_DEPTH, type SteeringItem } from './steering-score.js'
import { appendJsonl, benchFiles, loadBench, readJsonl, sha256Of, writeJson } from './store.js'
import type { Searcher } from './systems.js'
import type { BenchQuery, Judgment, Run } from './types.js'

export const steeringFile = (dir: string) => path.join(dir, 'steering.jsonl')

export const asQuery = (item: SteeringItem): BenchQuery => ({
  id: item.id,
  stratum: 'steering',
  text: item.text,
  dataClass: item.dataClass,
  goldSessionIds: item.gold,
  goldSummaryKind: null,
  goldProjectPath: null,
  sourceNote: item.sourceNote,
  replay: {},
  notAfter: null,
  excludeSessionIds: [],
  steering: { toward: item.toward, away: item.away },
})

type TagGroup = { tag: string; sessions: number[] }

// Agent-assigned topic tags seed the candidates only. Every gold and
// off-target session is then graded by the judge against the item's query,
// because the tags were bulk-assigned, possibly with this same vector search,
// and would flatter it as ground truth.
const tagGroups = async (snapshot: number): Promise<TagGroup[]> =>
  (
    await query<{ tag: string; sessions: number[] }>(
      `SELECT t.tag, array_agg(DISTINCT t.session_id ORDER BY t.session_id) AS sessions
       FROM tags t JOIN sessions s ON s.id = t.session_id
       WHERE t.session_id IS NOT NULL AND t.tag <> $2 AND s.id <= $1
         AND s.deleted_at IS NULL AND NOT s.is_automated AND s.summary IS NOT NULL
       GROUP BY t.tag HAVING count(DISTINCT t.session_id) >= 6`,
      [snapshot, USELESS_TAG]
    )
  ).rows

const titlesOf = async (ids: number[]) =>
  (await query<{ title: string | null }>(`SELECT title FROM sessions WHERE id = ANY($1::int[])`, [ids])).rows
    .map((r) => r.title ?? '')
    .filter(Boolean)

const ASK = (titles: string[]) =>
  `These past conversations share one topic:\n${titles.map((t) => `- ${t.slice(0, 300)}`).join('\n')}\n\nWrite the 3 to 8 word search query someone would type to find conversations on that topic. Reply {"query": "..."}.`

export type SteeringBuild = { dir: string; seed: string; base: Searcher; target: number; log: (line: string) => void }

export const buildSteering = async ({ dir, seed, base, target, log }: SteeringBuild) => {
  const { files, manifest } = loadBench(dir)
  const out = steeringFile(dir)
  const existing = readJsonl<SteeringItem>(out)
  if (existing.length >= target) return existing
  const groups = shuffled(await tagGroups(manifest.snapshotMaxSessionId), `steer:${seed}`)
  const tagsBySession = new Map<number, string[]>()
  for (const g of groups) for (const id of g.sessions) tagsBySession.set(id, [...(tagsBySession.get(id) ?? []), g.tag])
  const judgeFile = path.join(files.build, 'steering-judgments.jsonl')
  const graded = async (q: BenchQuery, ids: number[]) => {
    const fresh = await judgePairs(
      ids.map((sessionId) => ({ query: q, sessionId, snippets: [] })),
      { model: manifest.judgeModel, cwd: files.judgeCwd, out: files.judgments }
    )
    appendJsonl(judgeFile, fresh)
    return new Map(fresh.map((j) => [j.sessionId, j.grade]))
  }
  const items = [...existing]
  for (const [gi, group] of groups.entries()) {
    if (items.length >= target) break
    const id = `steering-${gi}`
    if (items.some((i) => i.id === id)) continue
    const sample = shuffled(group.sessions, `${id}:titles`).slice(0, 3)
    const { query: text } = await withRetries(3, async () =>
      extractJson<{ query: string }>(
        await callClaude({ model: 'haiku', cwd: files.judgeCwd, system: 'Reply with only JSON.', prompt: ASK(await titlesOf(sample)) })
      )
    )
    const draft: BenchQuery = asQuery({ id, text, dataClass: ['*'], toward: [], away: [], gold: [], offTarget: [], sourceNote: '' })
    const baseRun = await base(draft)
    if (baseRun.degraded) throw new Error(`base search degraded while building steering items: ${baseRun.degraded}`)
    const listed = baseRun.results.map((r) => r.sessionId)
    const inTopic = new Set(group.sessions)
    // Toward: up to two on-topic sessions the base search already shows,
    // the way a person clicks a good result to ask for more like it.
    const toward = listed.filter((s) => inTopic.has(s)).slice(0, 2)
    if (toward.length === 0) {
      log(`${id}: base search shows no on-topic session; skipped`)
      continue
    }
    // Away: the tag most present among the base results' off-topic hits.
    const rival = new Map<string, number>()
    for (const s of listed.filter((s) => !inTopic.has(s)))
      for (const tag of tagsBySession.get(s) ?? []) if (tag !== group.tag) rival.set(tag, (rival.get(tag) ?? 0) + 1)
    const rivalTag = [...rival].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!rivalTag) {
      log(`${id}: no confusable topic among the base results; skipped`)
      continue
    }
    const rivalSessions = groups.find((g) => g.tag === rivalTag)!.sessions.filter((s) => !inTopic.has(s))
    const goldCandidates = group.sessions.filter((s) => !toward.includes(s)).slice(0, 15)
    const offCandidates = [...new Set([...listed.filter((s) => rivalSessions.includes(s)), ...rivalSessions])].slice(0, 15)
    const grades = await graded(draft, [...new Set([...goldCandidates, ...offCandidates, ...listed])])
    const away = listed.filter((s) => rivalSessions.includes(s) && (grades.get(s) ?? 0) <= 1).slice(0, 2)
    const gold = goldCandidates.filter((s) => (grades.get(s) ?? 0) >= 2)
    const offTarget = offCandidates.filter((s) => !away.includes(s) && (grades.get(s) ?? 3) <= 1)
    if (away.length === 0 || gold.length === 0) {
      log(`${id}: ${gold.length} judged gold, ${away.length} judged-irrelevant away examples; skipped`)
      continue
    }
    const item: SteeringItem = {
      id,
      text,
      dataClass: ['*'],
      toward,
      away,
      gold,
      offTarget,
      sourceNote: `seeded from tag group ${gi} vs a confusable tag; gold and off-target judged by ${manifest.judgeModel}`,
    }
    appendJsonl(out, [item])
    items.push(item)
    log(`${id}: kept (${gold.length} gold, ${offTarget.length} off-target)`)
  }
  return items
}

export type SteeringRun = { base: Searcher; toward: Searcher; away: Searcher; names: { base: string; toward: string; away: string } }

// Three searches per item at depth 20: no examples, toward examples, away
// examples. Pairs in any top ten the cache has not graded are judged first.
export const runSteering = async (dir: string, name: string, systems: SteeringRun, log: (line: string) => void) => {
  const { files, manifest } = loadBench(dir)
  const items = readJsonl<SteeringItem>(steeringFile(dir))
  const runFile = (kind: keyof SteeringRun['names']) => files.run(`${name}-steer-${kind}-${systems.names[kind]}`)
  const lists: Record<string, Map<string, number[]>> = {}
  for (const kind of ['base', 'toward', 'away'] as const) {
    const done = new Map(readJsonl<Run>(runFile(kind)).map((r) => [r.queryId, r]))
    for (const item of items) {
      if (done.has(item.id)) continue
      const run = await systems[kind](asQuery(item))
      const full: Run = { system: systems.names[kind], ...run }
      appendJsonl(runFile(kind), [full])
      done.set(item.id, full)
    }
    // The same snapshot cut core scoring applies: later ingestion must not move it.
    lists[kind] = new Map(
      [...done].map(([id, r]) => [
        id,
        r.results.map((x) => x.sessionId).filter((s) => s <= manifest.snapshotMaxSessionId).slice(0, STEER_DEPTH),
      ])
    )
  }
  const judgments = readJsonl<Judgment>(files.judgments)
  const seen = new Set(judgments.filter((j) => j.repeat === 0 && j.promptVersion === manifest.promptVersion).map((j) => `${j.queryId}:${j.sessionId}`))
  const pairs = items.flatMap((item) =>
    [...new Set([...lists.base.get(item.id)!.slice(0, 10), ...lists.toward.get(item.id)!.slice(0, 10)])]
      .filter((s) => !seen.has(`${item.id}:${s}`))
      .map((sessionId) => ({ query: asQuery(item), sessionId, snippets: [] }))
  )
  if (pairs.length) {
    log(`judging ${pairs.length} steering pairs`)
    await judgePairs(pairs, { model: manifest.judgeModel, cwd: files.judgeCwd, out: files.judgments })
  }
  const grades = indexJudgments(readJsonl<Judgment>(files.judgments), manifest.promptVersion)
  const scores = items.map((item) =>
    scoreSteering(
      item,
      { base: lists.base.get(item.id)!, toward: lists.toward.get(item.id)!, away: lists.away.get(item.id)! },
      grades.get(item.id) ?? new Map()
    )
  )
  const report = { ...reportSteering(systems.names, scores), steeringSha256: existsSync(steeringFile(dir)) ? sha256Of(steeringFile(dir)) : null }
  writeJson(path.join(dir, 'reports', `${name}-steering.json`), { report, scores })
  return report
}
