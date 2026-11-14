import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const cli = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; cwd: string; stdin: string }[],
  reply: { code: 0 as number | null, stdout: '', stderr: '' },
}))

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: { cwd: string }) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
    return Object.assign(child, {
      stdin: {
        end: (input: string) => {
          cli.calls.push({ command, args, cwd: options.cwd, stdin: input })
          setImmediate(() => {
            child.stdout.emit('data', cli.reply.stdout)
            child.stderr.emit('data', cli.reply.stderr)
            child.emit('close', cli.reply.code)
          })
        },
      },
    })
  },
}))

const { callClaude, extractJson, ModelRefusal, pool, withRetries } = await import('./claude.js')

const emptyDir = () => mkdtempSync(path.join(os.tmpdir(), 'bench-claude-'))
const call = (cwd: string) => callClaude({ model: 'haiku', system: 'system-text-quiet-heron', prompt: 'prompt-text-amber-fox', cwd })

afterEach(() => {
  cli.calls.length = 0
  cli.reply = { code: 0, stdout: '', stderr: '' }
  vi.useRealTimers()
})

describe('callClaude', () => {
  // A judge call that persisted a transcript, loaded settings or reached a tool
  // would put benchmark queries into the corpus being measured.
  it('runs claude hermetically in the given cwd and sends the prompt on stdin', async () => {
    cli.reply.stdout = JSON.stringify({ result: 'answer-text-jolly-otter' })
    const cwd = emptyDir()
    expect(await call(cwd)).toBe('answer-text-jolly-otter')
    const [{ command, args, cwd: ranIn, stdin }] = cli.calls
    expect(command).toBe('claude')
    expect(ranIn).toBe(cwd)
    expect(stdin).toBe('prompt-text-amber-fox')
    expect(args).toContain('--no-session-persistence')
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', ''])
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', ''])
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2)).toEqual(['--mcp-config', '{"mcpServers":{}}'])
    expect(args).toContain('--strict-mcp-config')
    expect(args.slice(args.indexOf('--system-prompt'), args.indexOf('--system-prompt') + 2)).toEqual(['--system-prompt', 'system-text-quiet-heron'])
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'haiku'])
  })

  it('creates a missing cwd rather than failing', async () => {
    cli.reply.stdout = JSON.stringify({ result: 'ok' })
    const cwd = path.join(emptyDir(), 'judge-cwd')
    await call(cwd)
    expect(readdirSync(cwd)).toEqual([])
  })

  // A non-empty cwd could hold a CLAUDE.md that steers the judge.
  it('refuses a cwd that is not empty, without spawning', async () => {
    const cwd = emptyDir()
    writeFileSync(path.join(cwd, 'CLAUDE.md'), 'stray-file-wobbly-yak')
    await expect(call(cwd)).rejects.toThrow(/must be empty/)
    expect(cli.calls).toHaveLength(0)
  })

  it('throws ModelRefusal on a refusal, even when the exit code is nonzero', async () => {
    cli.reply = { code: 1, stdout: JSON.stringify({ stop_reason: 'refusal', is_error: true }), stderr: '' }
    await expect(call(emptyDir())).rejects.toBeInstanceOf(ModelRefusal)
  })

  it('reports stderr when claude exits nonzero', async () => {
    cli.reply = { code: 2, stdout: '', stderr: 'stderr-text-grumpy-badger' }
    await expect(call(emptyDir())).rejects.toThrow(/exited 2: stderr-text-grumpy-badger/)
  })

  it('treats an is_error reply as a failure, not an answer', async () => {
    cli.reply.stdout = JSON.stringify({ result: 'partial-text-soggy-lantern', is_error: true })
    const error = await call(emptyDir()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ModelRefusal)
  })

  it('treats unparseable output as a failure', async () => {
    cli.reply.stdout = 'not-json-rusty-cello'
    await expect(call(emptyDir())).rejects.toThrow(/returned an error/)
  })
})

describe('extractJson', () => {
  it('takes the outermost object from a fenced reply', () => {
    expect(extractJson('```json\n{"a":{"b":1}}\n```')).toEqual({ a: { b: 1 } })
  })

  it('throws when there is no object', () => {
    expect(() => extractJson('no braces here')).toThrow(/no JSON object/)
  })
})

describe('withRetries', () => {
  it('retries a transient failure and returns the eventual answer', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('second-try')
    const result = withRetries(3, fn)
    await vi.runAllTimersAsync()
    expect(await result).toBe('second-try')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  // A refusal is deterministic for its prompt: retrying only burns calls.
  it('never retries a refusal', async () => {
    const fn = vi.fn().mockRejectedValue(new ModelRefusal('refused'))
    await expect(withRetries(3, fn)).rejects.toBeInstanceOf(ModelRefusal)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up after the last attempt with the last error', async () => {
    vi.useFakeTimers()
    const fn = vi.fn().mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('last'))
    const result = expect(withRetries(2, fn)).rejects.toThrow('last')
    await vi.runAllTimersAsync()
    await result
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('pool', () => {
  it('keeps results in input order and never exceeds the concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const out = await pool([30, 10, 20, 5, 15], 2, async (delay, i) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, delay))
      inFlight--
      return `${i}:${delay}`
    })
    expect(out).toEqual(['0:30', '1:10', '2:20', '3:5', '4:15'])
    expect(peak).toBe(2)
  })
})
