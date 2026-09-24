#!/usr/bin/env tsx
/**
 * Watch the `useless` penalty move a ranking, and check that the direction it
 * relies on still has any signal in it.
 *
 *   pnpm run search:tune "relay coordinator handoff"
 *   pnpm run search:tune "relay coordinator handoff" --beta 0,0.35,1.0 --limit 10
 *   pnpm run search:tune --diagnose
 *
 * The point of the beta sweep is the CONTROL: beta=0 is the ranking as it was
 * before this feature existed, so every column is read against it rather than
 * against an intuition about what should have matched.
 */

// src/config.ts does not load .env -- only entrypoints do. Without this the
// script silently falls back to the default password and times out connecting.
import 'dotenv/config'

import { searchWithDiagnostics } from '../src/mcp/search.js'
import {
  loadQualityVector,
  loadAllSessionCentroids,
  loadTaggedSessionCentroids,
  loadRandomSessionCentroids,
  loadSessionCentroidsByIds,
  computeGlobalMean,
  computeDirection,
  directionUsability,
  USELESS_VECTOR,
  GLOBAL_MEAN_VECTOR,
} from '../src/services/quality-vectors.js'
import { centerVector, cosineSimilarity, magnitude } from '../src/utils/vector-math.js'
import { closePool } from '../src/db/postgres.js'
import { config } from '../src/config.js'

const argv = process.argv.slice(2)

// Flags that take a value, so their value is never mistaken for the query.
const VALUED = new Set(['--beta', '--limit'])
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const positional = argv.filter(
  (arg, i) => !arg.startsWith('--') && !VALUED.has(argv[i - 1] ?? '')
)
const queryText = positional[0]
const betas = (flag('beta') ?? '0,0.2,0.35,0.6,1.0').split(',').map(Number)
const limit = Number(flag('limit') ?? 10)

if (betas.some((b) => !Number.isFinite(b))) {
  console.error(`--beta must be comma-separated numbers, got "${flag('beta')}"`)
  process.exit(1)
}
// beta=0 is the control every other column is read against; without it the
// output would show movement with nothing to measure it from.
if (!betas.includes(0)) betas.unshift(0)

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

/**
 * Reproduce the cohesion/separation measurement from scratch, against the live
 * corpus. Not a cached read of quality_vectors: the stored numbers are what was
 * true when compute:centroids last ran, and the question here is whether they
 * are still true.
 */
const diagnose = async () => {
  const dims = config.embeddings.dimensions
  console.log('Recomputing from live data (not reading quality_vectors)...\n')

  const all = await loadAllSessionCentroids(dims)
  const members = await loadTaggedSessionCentroids(USELESS_VECTOR, dims)
  if (members.length === 0) {
    console.log(`No sessions tagged "${USELESS_VECTOR}". Nothing to measure.`)
    return
  }
  const control = await loadRandomSessionCentroids(members.length, [USELESS_VECTOR], dims)
  const globalMean = computeGlobalMean(all)
  const { vector, cohesion, baseline } = computeDirection(members, control, globalMean)

  console.log(`corpus sessions with centroids : ${all.length}`)
  console.log(`sessions tagged "${USELESS_VECTOR}"        : ${members.length}`)
  // Anisotropy: how far the whole corpus leans in one direction. Near 0 would
  // mean centering is unnecessary; on bge-m3 it is nowhere near 0.
  console.log(`|| global mean || (anisotropy) : ${magnitude(globalMean).toFixed(4)}`)
  console.log('')
  console.log('COHESION  (|| mean of centered unit vectors ||; 1 = identical, 0 = random)')
  console.log(`  ${USELESS_VECTOR.padEnd(12)} ${cohesion.toFixed(4)}`)
  console.log(`  ${'random'.padEnd(12)} ${baseline.toFixed(4)}   <- the control; cohesion means nothing without it`)
  console.log(`  ratio        ${(cohesion / (baseline || 1)).toFixed(2)}x`)
  console.log('')

  const sims = (vs: number[][]) => vs.map((v) => cosineSimilarity(centerVector(v, globalMean), vector))
  const summarize = (label: string, vs: number[][]) => {
    const s = sims(vs).sort((a, b) => a - b)
    const mean = s.reduce((a, b) => a + b, 0) / s.length
    console.log(
      `  ${label.padEnd(12)} mean=${mean.toFixed(4)}  p10=${s[Math.floor(s.length * 0.1)].toFixed(4)}` +
        `  med=${s[Math.floor(s.length * 0.5)].toFixed(4)}  p90=${s[Math.floor(s.length * 0.9)].toFixed(4)}`
    )
  }
  console.log('SEPARATION  (centered cosine against the useless direction)')
  summarize(USELESS_VECTOR, members)
  summarize('random', control)
  console.log('')

  // False-positive rate at the members' own median: how much of the corpus gets
  // caught alongside half the labelled set.
  const med = sims(members).sort((a, b) => a - b)[Math.floor(members.length / 2)]
  const caught = sims(control).filter((s) => s > med).length
  console.log(
    `At a threshold of ${med.toFixed(3)} (the median labelled session): ` +
      `catches 50% of labelled, ${caught}/${control.length} (${pct(caught / control.length)}) of unlabelled.`
  )

  const stored = await loadQualityVector(USELESS_VECTOR)
  const usability = directionUsability(stored)
  console.log('')
  console.log(
    `Stored vector: ${stored ? `computed ${stored.computedAt.toISOString()}, ${stored.memberCount} members` : 'ABSENT'}`
  )
  console.log(`Search would ${usability.usable ? 'APPLY' : `SKIP the penalty (${usability.reason})`}.`)
  if (stored && Math.abs(stored.cohesion - cohesion) > 0.05)
    console.log(
      `WARNING: stored cohesion ${stored.cohesion.toFixed(4)} has drifted from live ${cohesion.toFixed(4)} — rerun compute:centroids.`
    )
}

const sweep = async (text: string) => {
  const runs: { beta: number; ids: number[]; titles: Map<number, string> }[] = []
  let steeringNote = ''

  for (const beta of betas) {
    const { results, steering } = await searchWithDiagnostics({
      query: text,
      limit,
      dataClass: ['*'],
      uselessPenalty: beta,
    })
    if (beta > 0 && !steering.active) steeringNote = `penalty INACTIVE: ${steering.reason}`
    runs.push({
      beta,
      ids: results.map((r) => r.session_id),
      titles: new Map(results.map((r) => [r.session_id, (r.title ?? '(untitled)').slice(0, 60)])),
    })
  }

  // Similarity per session, so a move has a visible cause rather than just
  // happening.
  const direction = await loadQualityVector(USELESS_VECTOR)
  const globalMean = await loadQualityVector(GLOBAL_MEAN_VECTOR)
  const allIds = [...new Set(runs.flatMap((r) => r.ids))]
  const centroids = await loadSessionCentroidsByIds(allIds)
  const simOf = (id: number): string => {
    const c = centroids.get(id)
    if (!c || !direction || !globalMean) return '  n/a'
    return cosineSimilarity(centerVector(c, globalMean.vector), direction.vector).toFixed(3).padStart(6)
  }

  const base = runs[0]
  console.log(`query: "${text}"   limit ${limit}`)
  if (steeringNote) console.log(`!! ${steeringNote}`)
  console.log('')

  for (const run of runs) {
    console.log(`--- beta = ${run.beta}${run.beta === base.beta ? '   (control: pre-feature ranking)' : ''}`)
    run.ids.forEach((id, i) => {
      const was = base.ids.indexOf(id)
      const move = run === base ? '  ' : was < 0 ? ' +' : was === i ? '  ' : was > i ? ` ${'^'}` : ` ${'v'}`
      const delta = run === base || was < 0 ? '' : was === i ? '' : ` (${was + 1}->${i + 1})`
      console.log(`  ${String(i + 1).padStart(2)}.${move} sim=${simOf(id)}  ${run.titles.get(id)}${delta}`)
    })
    const dropped = base.ids.filter((id) => !run.ids.includes(id))
    if (dropped.length > 0)
      console.log(`      dropped off the page: ${dropped.map((id) => `${id} (sim=${simOf(id).trim()})`).join(', ')}`)
    console.log('')
  }

  const identical = runs.every((r) => r.ids.join() === base.ids.join())
  if (identical)
    console.log('No ordering changed at any beta. Either nothing on this page resembles the labelled set, or the penalty is inactive.')
}

const main = async () => {
  try {
    if (argv.includes('--diagnose') || !queryText) {
      await diagnose()
      if (!queryText) console.log('\n(pass a query to sweep beta over a real ranking)')
    } else {
      await sweep(queryText)
    }
  } catch (error) {
    console.error('tune-search failed:', error)
    process.exit(1)
  } finally {
    await closePool()
  }
}

main()
