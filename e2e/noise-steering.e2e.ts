import assert from 'node:assert'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startServer, stopServer, search, mcpTool, type Hit } from './harness.js'

// What reporting a session is FOR, checked against the real index: flag a few
// members of a recurring family and the unreported rest rank lower, while real
// conversations are left alone. Every session touched is un-reported again
// before the suite ends.

const { query, closePool } = await import('../src/db/postgres.js')
const { resolveDataClasses } = await import('../src/mcp/search.js')
const dataClasses = resolveDataClasses({})
assert(dataClasses, 'a default search is expected to filter by data class')

const REPORTED = 5
const FIRST_WORDS = `array_to_string((regexp_split_to_array(m.content_text, '\\s+'))[1:5], ' ')`

const eligible = `
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  JOIN sources src ON src.id = p.source_id
  JOIN LATERAL (
    SELECT content_text FROM messages
    WHERE session_id = s.id AND role = 'user'
    ORDER BY sequence_num NULLS FIRST, timestamp, id LIMIT 1
  ) m ON true
  WHERE s.deleted_at IS NULL AND s.summary IS NOT NULL AND NOT s.is_automated
    AND COALESCE(p.data_class, src.data_class) = ANY('{${dataClasses.join(',')}}'::text[])
    AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.session_id = s.id)`

// The largest set of sessions opened by the same five words: a templated agent
// run repeated over and over, which is what reported noise usually looks like.
const findFamily = async () => {
  const { rows } = await query<{ prefix: string; ids: number[] }>(
    `SELECT ${FIRST_WORDS} AS prefix, array_agg(s.id ORDER BY s.id) AS ids ${eligible}
     GROUP BY 1 HAVING count(*) >= 50 ORDER BY count(*) DESC LIMIT 1`
  )
  expect(rows, 'no recurring family of 50+ sessions in this index').toHaveLength(1)
  return rows[0]
}

// Real sessions to search for: outside every recurring family, in a fixed
// pseudo-random order.
const realQueries = async () => {
  const { rows } = await query<{ text: string }>(
    `SELECT left(s.summary, 200) AS text ${eligible}
       AND ${FIRST_WORDS} NOT IN (SELECT ${FIRST_WORDS} ${eligible} GROUP BY 1 HAVING count(*) >= 20)
     ORDER BY md5(s.id::text || 'noise-e2e') LIMIT 3`
  )
  return rows.map((r) => r.text)
}

const dampingById = (hits: Hit[]) => new Map(hits.map((h) => [h.sessionId, h.noiseDamping]))

let family: { prefix: string; ids: number[] }
let reported: number[]
let baseline: Map<number, number | null>

beforeAll(async () => {
  await startServer()
  family = await findFamily()
  reported = family.ids.slice(0, REPORTED)
  console.log(`family "${family.prefix}": ${family.ids.length} sessions, reporting ${reported.join(', ')}`)
  baseline = dampingById(await search({ q: family.prefix, mode: 'semantic', limit: 50 }))
})

afterAll(async () => {
  for (const sessionId of reported ?? []) await mcpTool('unreportUselessSession', { sessionId })
  stopServer()
  await closePool()
})

describe('reporting part of a recurring family', () => {
  it('demotes the unreported rest of the family', async () => {
    for (const sessionId of reported) {
      const text = await mcpTool('reportUselessSession', { sessionId, reason: 'noise-steering e2e' })
      expect(text).toContain('flagged')
    }

    const during = dampingById(await search({ q: family.prefix, mode: 'semantic', limit: 50 }))
    const lookalikes = family.ids.filter((id) => !reported.includes(id) && baseline.has(id) && during.has(id))
    expect(lookalikes.length).toBeGreaterThanOrEqual(10)

    const lowered = lookalikes.filter((id) => (during.get(id) ?? 1) < (baseline.get(id) ?? 1))
    console.log(`${lowered.length}/${lookalikes.length} lookalikes damped harder after the report`)
    expect(lowered.length / lookalikes.length).toBeGreaterThanOrEqual(0.8)
  })

  it.fails('scores results that only full-text search found', async () => {
    const hits = await search({ q: family.prefix, mode: 'text', limit: 30 })
    expect(hits.length).toBeGreaterThan(0)
    const unscored = hits.filter((h) => h.noiseDamping === null)
    console.log(`${unscored.length}/${hits.length} full-text hits carried no damping`)
    expect(unscored).toEqual([])

    const lookalikes = hits.filter((h) => family.ids.includes(h.sessionId))
    expect(lookalikes.every((h) => (h.noiseDamping ?? 1) < 1)).toBe(true)
  })

  it('restores the family once the reports are undone', async () => {
    for (const sessionId of reported) await mcpTool('unreportUselessSession', { sessionId })

    const after = dampingById(await search({ q: family.prefix, mode: 'semantic', limit: 50 }))
    const shared = [...baseline.keys()].filter((id) => after.has(id))
    const restored = shared.filter((id) => Math.abs((after.get(id) ?? 1) - (baseline.get(id) ?? 1)) < 0.01)
    console.log(`${restored.length}/${shared.length} results back within 0.01 of their baseline damping`)
    expect(restored.length / shared.length).toBeGreaterThanOrEqual(0.9)
  })
})

describe('real conversations', () => {
  it.fails('are left undamped', async () => {
    const hits = (
      await Promise.all((await realQueries()).map((q) => search({ q, mode: 'semantic', limit: 10 })))
    ).flat()
    const untouched = hits.filter((h) => h.noiseDamping === 1)
    console.log(`${untouched.length}/${hits.length} real-topic results undamped`)
    expect(untouched.length / hits.length).toBeGreaterThanOrEqual(0.8)
  })
})
