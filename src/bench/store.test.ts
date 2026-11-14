import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadBench, writeJson } from './store.js'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const bench = (queryIds: string[], judgedIds: string[]) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bench-store-'))
  dirs.push(dir)
  writeJson(path.join(dir, 'manifest.json'), { queriesSha256: null })
  writeFileSync(path.join(dir, 'queries.jsonl'), queryIds.map((id) => JSON.stringify({ id })).join('\n') + '\n')
  writeFileSync(
    path.join(dir, 'judgments.jsonl'),
    judgedIds.map((queryId) => JSON.stringify({ queryId, sessionId: 1, grade: 2, repeat: 0 })).join('\n') + '\n'
  )
  return dir
}

describe('loadBench', () => {
  it('returns only judgments of queries in the set', () => {
    const { judgments } = loadBench(bench(['kept'], ['kept', 'dropped-before-freeze', 'steering-3']))
    expect(judgments.map((j) => j.queryId)).toEqual(['kept'])
  })
})
