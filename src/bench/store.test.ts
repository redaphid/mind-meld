import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendJsonl, loadBench, readIdList, readJsonl, sha256Of, writeJson } from './store.js'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bench-store-'))
  dirs.push(dir)
  return dir
}

const bench = (queryIds: string[], judgedIds: string[]) => {
  const dir = tempDir()
  writeJson(path.join(dir, 'manifest.json'), { queriesSha256: null })
  writeFileSync(path.join(dir, 'queries.jsonl'), queryIds.map((id) => JSON.stringify({ id })).join('\n') + '\n')
  writeFileSync(
    path.join(dir, 'judgments.jsonl'),
    judgedIds.map((queryId) => JSON.stringify({ queryId, sessionId: 1, grade: 2, repeat: 0 })).join('\n') + '\n'
  )
  return dir
}

const freeze = (dir: string) => writeJson(path.join(dir, 'manifest.json'), { queriesSha256: sha256Of(path.join(dir, 'queries.jsonl')) })

describe('loadBench', () => {
  it('returns only judgments of queries in the set', () => {
    const { judgments } = loadBench(bench(['kept'], ['kept', 'dropped-before-freeze', 'steering-3']))
    expect(judgments.map((j) => j.queryId)).toEqual(['kept'])
  })

  it('loads a frozen set whose queries are unchanged', () => {
    const dir = bench(['query-id-soggy-lantern'], [])
    freeze(dir)
    expect(loadBench(dir).queries.map((q) => q.id)).toEqual(['query-id-soggy-lantern'])
  })

  // Scores against an edited set are not comparable with earlier runs.
  it('refuses a frozen set whose queries have been edited', () => {
    const dir = bench(['query-id-soggy-lantern'], [])
    freeze(dir)
    writeFileSync(path.join(dir, 'queries.jsonl'), JSON.stringify({ id: 'query-id-swapped-in' }) + '\n')
    expect(() => loadBench(dir)).toThrow(/no longer matches its frozen hash/)
  })
})

describe('jsonl files', () => {
  it('reads a missing file as empty', () => {
    expect(readJsonl(path.join(tempDir(), 'absent.jsonl'))).toEqual([])
  })

  it('appends rows after existing ones, creating the directory, and round-trips them', () => {
    const file = path.join(tempDir(), 'nested', 'rows.jsonl')
    appendJsonl(file, [{ a: 1 }])
    appendJsonl(file, [{ a: 2 }, { a: 3 }])
    expect(readJsonl(file)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })

  it('writes nothing for no rows', () => {
    const file = path.join(tempDir(), 'rows.jsonl')
    appendJsonl(file, [])
    expect(existsSync(file)).toBe(false)
  })
})

describe('readIdList', () => {
  it('reads one id per line, ignoring blank lines and padding', () => {
    const file = path.join(tempDir(), 'looped-session-ids.txt')
    writeFileSync(file, '12\n\n  34 \r\n56\n')
    expect(readIdList(file)).toEqual([12, 34, 56])
  })

  it('reads a missing optional list as empty', () => {
    expect(readIdList(path.join(tempDir(), 'absent.txt'))).toEqual([])
  })
})
