import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { sessionCard } from './corpus.js'
import { JUDGE_SYSTEM, judgePairs, renderCard } from './judge.js'
import { agreement, shuffled, type Agreement } from './metrics.js'
import { loadBench, readJson, writeJson } from './store.js'
import { STRATA, type Judgment } from './types.js'

const RETEST_SHARE = 0.1
const OPUS_PAIRS = 60

const key = (j: Pick<Judgment, 'queryId' | 'sessionId'>) => `${j.queryId}:${j.sessionId}`

// The share of gold sessions the judge grades 2 or 3 for their own query. Low
// means the query writer or the judge is broken, and nothing downstream holds.
export const goldSanity = (dir: string) => {
  const { manifest, queries, judgments } = loadBench(dir)
  const first = new Map(
    judgments.filter((j) => j.repeat === 0 && j.promptVersion === manifest.promptVersion).map((j) => [key(j), j.grade])
  )
  return STRATA.filter((s) => s !== 'noanswer').map((stratum) => {
    const grades = queries
      .filter((q) => q.stratum === stratum)
      .flatMap((q) => q.goldSessionIds.map((id) => first.get(`${q.id}:${id}`)))
      .filter((g): g is Judgment['grade'] => g !== undefined)
    return {
      stratum,
      n: grades.length,
      relevant: grades.length ? grades.filter((g) => g >= 2).length / grades.length : null,
      exact: grades.length ? grades.filter((g) => g === 3).length / grades.length : null,
    }
  })
}

// A seeded tenth of the judged pairs, judged again in a different order among
// different neighbours, compared with the first judgment.
export const retest = async (dir: string, log = console.error): Promise<Agreement> => {
  const { files, manifest, queries, judgments } = loadBench(dir)
  const current = judgments.filter((j) => j.promptVersion === manifest.promptVersion)
  const first = current.filter((j) => j.repeat === 0)
  const sample = shuffled(first, `retest:${manifest.seed}`).slice(0, Math.ceil(first.length * RETEST_SHARE))
  const done = new Map(current.filter((j) => j.repeat === 1).map((j) => [key(j), j.grade]))
  const byId = new Map(queries.map((q) => [q.id, q]))
  const todo = sample.filter((j) => !done.has(key(j)))
  log(`retesting ${todo.length} of ${sample.length} sampled pairs`)
  const fresh = await judgePairs(
    todo.map((j) => ({ query: byId.get(j.queryId)!, sessionId: j.sessionId, snippets: [] })),
    {
      model: manifest.judgeModel,
      cwd: files.judgeCwd,
      out: files.judgments,
      repeat: 1,
      onRefused: (p) => log(`judge refused ${p.query.id}:${p.sessionId}; left out of the retest`),
    }
  )
  for (const j of fresh) done.set(key(j), j.grade)
  const paired = sample.filter((j) => done.has(key(j)))
  return agreement(
    paired.map((j) => j.grade),
    paired.map((j) => done.get(key(j))!)
  )
}

const validationDir = (dir: string) => path.join(dir, 'validation')

// Sixty pairs spread over grades and strata, rendered exactly as the judge
// saw them (minus the snippets, which are not cached), for an independent
// grader. Writes the cards and the key that maps labels back to pairs.
export const exportForOpus = async (dir: string) => {
  const { manifest, queries, judgments } = loadBench(dir)
  const byId = new Map(queries.map((q) => [q.id, q]))
  const first = judgments.filter((j) => j.repeat === 0 && j.promptVersion === manifest.promptVersion)
  const cells = new Map<string, Judgment[]>()
  for (const j of shuffled(first, `opus:${manifest.seed}`)) {
    const cell = `${byId.get(j.queryId)!.stratum}:${j.grade}`
    cells.set(cell, [...(cells.get(cell) ?? []), j])
  }
  const picked: Judgment[] = []
  for (let round = 0; picked.length < OPUS_PAIRS && round < 100; round++)
    for (const cell of cells.values()) if (cell[round] && picked.length < OPUS_PAIRS) picked.push(cell[round])
  const blocks: string[] = []
  const keyRows: { label: string; queryId: string; sessionId: number }[] = []
  for (const [i, j] of shuffled(picked, 'opus-order').entries()) {
    const label = `P${i + 1}`
    const card = await sessionCard(j.sessionId, { messages: 4, chars: 300 })
    blocks.push(`## Pair ${label}\nSearch query: ${JSON.stringify(byId.get(j.queryId)!.text)}\n\n${renderCard(label, card!, [])}`)
    keyRows.push({ label, queryId: j.queryId, sessionId: j.sessionId })
  }
  const out = validationDir(dir)
  writeJson(path.join(out, 'opus-key.json'), keyRows)
  writeFileSync(
    path.join(out, 'opus-pairs.md'),
    `${JUDGE_SYSTEM.replace('several candidate conversations', 'one candidate conversation per pair')}\n\nGrade each pair independently. Write {"P1": <grade>, ...} for all ${keyRows.length} pairs to opus-grades.json beside this file.\n\n${blocks.join('\n\n')}\n`
  )
  return { pairs: keyRows.length, file: path.join(out, 'opus-pairs.md') }
}

export const opusAgreement = (dir: string) => {
  const out = validationDir(dir)
  const gradesFile = path.join(out, 'opus-grades.json')
  if (!existsSync(gradesFile)) return null
  const { manifest, queries, judgments } = loadBench(dir)
  const keyRows = readJson<{ label: string; queryId: string; sessionId: number }[]>(path.join(out, 'opus-key.json'))
  const opus = readJson<Record<string, number>>(gradesFile)
  const haiku = new Map(
    judgments.filter((j) => j.repeat === 0 && j.promptVersion === manifest.promptVersion).map((j) => [key(j), j.grade])
  )
  const rows = keyRows.filter((r) => opus[r.label] !== undefined)
  const stratumOf = new Map(queries.map((q) => [q.id, q.stratum]))
  const confusion: Record<string, number> = {}
  for (const r of rows) {
    const cell = `haiku${haiku.get(key(r))}-opus${opus[r.label]}`
    confusion[cell] = (confusion[cell] ?? 0) + 1
  }
  return {
    ...agreement(
      rows.map((r) => haiku.get(key(r))!),
      rows.map((r) => opus[r.label])
    ),
    haikuMeanGrade: rows.reduce((s, r) => s + haiku.get(key(r))!, 0) / rows.length,
    opusMeanGrade: rows.reduce((s, r) => s + opus[r.label], 0) / rows.length,
    byStratum: Object.fromEntries(STRATA.map((s) => [s, rows.filter((r) => stratumOf.get(r.queryId) === s).length])),
    confusion,
  }
}
