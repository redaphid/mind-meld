import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'

// Claude Code transcripts are indexed by mindmeld, so a judge call that left
// one behind would put benchmark queries, and their answers, into the corpus
// being measured. Every flag here closes one way that happens: no transcript
// on disk, no user/project settings (so no hooks or plugins), no MCP servers,
// no tools, a replacement system prompt (no CLAUDE.md), and a cwd that is an
// empty directory. Verify with a before/after listing of ~/.claude/projects
// after changing any of it.
const HERMETIC_FLAGS = [
  '--no-session-persistence',
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--tools',
  '',
  '--output-format',
  'json',
]

export type ClaudeCall = { model: string; system: string; prompt: string; cwd: string; effort?: string }

// The model declined the content. Deterministic for a given prompt, so it is
// never retried; callers decide what to do without that answer.
export class ModelRefusal extends Error {}

type CliResult = { result?: string; is_error?: boolean; stop_reason?: string }

const parseCli = (stdout: string): CliResult | null => {
  try {
    return JSON.parse(stdout) as CliResult
  } catch {
    return null
  }
}

export const callClaude = async ({ model, system, prompt, cwd, effort = 'low' }: ClaudeCall): Promise<string> => {
  mkdirSync(cwd, { recursive: true })
  if (readdirSync(cwd).length > 0) throw new Error(`judge cwd must be empty: ${cwd}`)
  const args = ['-p', '--model', model, '--effort', effort, ...HERMETIC_FLAGS, '--system-prompt', system]
  const { code, out, err } = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
    child.stdin.end(prompt)
  })
  const parsed = parseCli(out)
  if (parsed?.stop_reason === 'refusal') throw new ModelRefusal(`${model} refused the prompt`)
  if (code !== 0) throw new Error(`claude exited ${code}: ${err}${out}`)
  if (!parsed || parsed.is_error || typeof parsed.result !== 'string') throw new Error(`claude returned an error: ${out}`)
  return parsed.result
}

// Model output often wraps JSON in prose or a fence; take the outermost object.
export const extractJson = <T>(text: string): T => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error(`no JSON object in model output: ${text}`)
  return JSON.parse(text.slice(start, end + 1)) as T
}

export const withRetries = async <T>(attempts: number, fn: () => Promise<T>): Promise<T> => {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof ModelRefusal) throw e
      last = e
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
    }
  }
  throw last
}

export const pool = async <T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    })
  )
  return out
}
