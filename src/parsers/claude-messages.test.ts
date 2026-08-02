import { describe, it, expect } from 'vitest'
import { parseClaudeLine } from './claude-messages.js'

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    uuid: 'u1',
    parentUuid: null,
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:00:00Z',
    cwd: '/home/me/Projects/mind-meld',
    gitBranch: 'main',
    version: '2.1.0',
    message: { role: 'user', content: 'hello there' },
    ...over,
  })

const asMessage = (raw: string) => {
  const result = parseClaudeLine(raw, 0)
  if (result.kind !== 'message') throw new Error(`expected a message, got skip: ${result.reason}`)
  return result
}

describe('parseClaudeLine', () => {
  it('reads a user message and the metadata it contributes', () => {
    const { message, metadata } = asMessage(line())
    expect(message).toMatchObject({ uuid: 'u1', role: 'user', contentText: 'hello there' })
    expect(message.timestamp).toEqual(new Date('2026-01-01T00:00:00Z'))
    expect(metadata).toMatchObject({ sessionId: 'sess-1', gitBranch: 'main', claudeVersion: '2.1.0' })
  })

  it('classifies an assistant tool call as a tool message', () => {
    const { message } = asMessage(
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
        },
      })
    )
    expect(message.role).toBe('tool')
    expect(message.toolName).toBe('Bash')
    expect(message.toolInput).toEqual({ command: 'ls' })
  })

  it('reports only the assistant model, so a user line cannot set it', () => {
    const { metadata } = asMessage(line({ message: { role: 'user', content: 'hi', model: 'wrong' } }))
    expect(metadata.modelUsed).toBeUndefined()
  })

  it('sums the tokens a line contributes', () => {
    const { metadata } = asMessage(
      line({
        type: 'assistant',
        message: { role: 'assistant', content: 'ok', usage: { input_tokens: 10, output_tokens: 4 } },
      })
    )
    expect(metadata).toMatchObject({ inputTokens: 10, outputTokens: 4 })
  })

  it('skips entries that are not messages', () => {
    expect(parseClaudeLine(line({ type: 'file-history-snapshot' }), 0)).toEqual({
      kind: 'skip',
      reason: 'not a message (type: file-history-snapshot)',
    })
  })

  it('skips a message whose timestamp cannot be trusted', () => {
    const result = parseClaudeLine(line({ timestamp: 'not-a-date' }), 0)
    expect(result.kind).toBe('skip')
    expect(result.kind === 'skip' && result.reason).toContain('invalid timestamp')
  })

  // Malformed input throws so the caller can quarantine the raw line rather
  // than silently dropping it — that distinction is the whole point of the split.
  it('throws on a line it cannot read at all', () => {
    expect(() => parseClaudeLine('{"broken', 0)).toThrow()
  })

  it('keeps the sequence number it was handed', () => {
    expect(asMessage(line()).message.sequenceNum).toBe(0)
    const result = parseClaudeLine(line(), 42)
    expect(result.kind === 'message' && result.message.sequenceNum).toBe(42)
  })
})

// Windows tools (wsl.exe, PowerShell) emit UTF-16LE; captured as UTF-8, each
// character arrives followed by NUL, recorded in the transcript as escaped
// NULs that JSON.parse turns into real U+0000 — which Postgres rejects
// outright (issue #20). The parser must hand back the *decoded* text, not the
// mangled bytes and not merely NUL-stripped ones.
describe('parseClaudeLine: UTF-16LE console output (issue #20)', () => {
  const NUL = String.fromCharCode(0)
  const utf16le = (text: string) => [...text].map((c) => c + NUL).join('')

  it('decodes wsl.exe output back to readable text', () => {
    // JSON.stringify writes each NUL as the escape sequence, reproducing the
    // failing transcript lines byte-for-byte.
    const raw = line({
      message: {
        role: 'user',
        content: `Exit code 255\n${utf16le('WSL version: 2.6.1.0\r\n\r\nKernel version: 6.6.87')}`,
      },
    })
    expect(raw).toContain('\\u0000')
    const { message } = asMessage(raw)
    expect(message.contentText).toBe(
      'Exit code 255\nWSL version: 2.6.1.0\r\n\r\nKernel version: 6.6.87'
    )
  })

  it('leaves no NULs or lone surrogates anywhere in the parsed record', () => {
    const raw = line({
      gitBranch: `mai${NUL}n`,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: utf16le('WSL version: 2.6.1.0') },
          { type: 'tool_result', content: `stray${NUL} and \uD800 half` },
        ],
      },
    })
    const { message, metadata } = asMessage(raw)
    expect(message.contentText).toBe('WSL version: 2.6.1.0\nstray and  half')
    expect(metadata.gitBranch).toBe('main')
    expect(JSON.stringify(message.contentJson)).not.toContain('\\u0000')
  })
})
