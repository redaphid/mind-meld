import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { BenchQuery, Judgment, Manifest } from './types.js'

export const readJsonl = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as T)
    : []

export const appendJsonl = (file: string, rows: unknown[]) => {
  if (rows.length === 0) return
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

export const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

export const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T

export const benchFiles = (dir: string) => ({
  queries: path.join(dir, 'queries.jsonl'),
  manifest: path.join(dir, 'manifest.json'),
  judgments: path.join(dir, 'judgments.jsonl'),
  judgeCwd: path.join(dir, 'judge-cwd'),
  runs: path.join(dir, 'runs'),
  run: (name: string) => path.join(dir, 'runs', `${name}.jsonl`),
  runMeta: (name: string) => path.join(dir, 'runs', `${name}.meta.json`),
  build: path.join(dir, 'build'),
})

export const sha256Of = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

export const loadBench = (dir: string) => {
  const files = benchFiles(dir)
  const manifest = readJson<Manifest>(files.manifest)
  if (manifest.queriesSha256 && sha256Of(files.queries) !== manifest.queriesSha256)
    throw new Error(`queries.jsonl in ${dir} no longer matches its frozen hash; the benchmark has been edited`)
  return {
    files,
    manifest,
    queries: readJsonl<BenchQuery>(files.queries),
    judgments: readJsonl<Judgment>(files.judgments),
  }
}
