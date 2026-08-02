import { describe, it, expect } from 'vitest'
import { normalizeText, normalizeDeep } from './text-encoding.js'

const NUL = String.fromCharCode(0)

// Interleaves every character with a NUL — exactly what wsl.exe's UTF-16LE
// output looks like once it has been read as UTF-8 and recorded in a
// transcript (issue #20).
const utf16le = (text: string) => [...text].map((c) => c + NUL).join('')
const utf16be = (text: string) => [...text].map((c) => NUL + c).join('')

// For ASCII-in-UTF-16LE — the only form this corruption takes, since
// non-ASCII arrives as NUL-free mojibake — removing the NULs IS the decode:
// the readable characters are already present in order. These cases pin that
// the repair yields the text the tool actually printed.
describe('normalizeText: UTF-16 run recovery', () => {
  // The real byte pattern from the failing transcript in issue #20.
  it('recovers a UTF-16LE run as the text it encodes', () => {
    expect(normalizeText(utf16le('WSL version: 2.6.1.0'))).toBe('WSL version: 2.6.1.0')
  })

  it('recovers the full multi-line tool output from the issue', () => {
    const mangled = utf16le('WSL version: 2.6.1.0\r\n\r\nKernel version: 6.6.87')
    expect(normalizeText(mangled)).toBe('WSL version: 2.6.1.0\r\n\r\nKernel version: 6.6.87')
  })

  // Transcripts mix clean UTF-8 (the shell wrapper, exit codes) with mangled
  // UTF-16 runs (the captured tool output). Only the run may change.
  it('recovers the run without touching surrounding clean text', () => {
    const mixed = `Exit code 255\n${utf16le('WSL version: 2.6.1.0')}\ndone`
    expect(normalizeText(mixed)).toBe('Exit code 255\nWSL version: 2.6.1.0\ndone')
  })

  it('recovers the big-endian alternation too', () => {
    expect(normalizeText(utf16be('WSL version'))).toBe('WSL version')
  })

  it('recovers a run whose final NUL was cut off', () => {
    expect(normalizeText(`W${NUL}S${NUL}L`)).toBe('WSL')
  })

  it('handles multiple separate runs in one string', () => {
    const two = `${utf16le('first')} then ${utf16le('second')}`
    expect(normalizeText(two)).toBe('first then second')
  })

  it('preserves every non-NUL character byte-for-byte (no truncation)', () => {
    const long = 'x'.repeat(10_000)
    expect(normalizeText(utf16le(long))).toBe(long)
    expect(normalizeText(long)).toBe(long)
  })
})

describe('normalizeText: stray NULs and lone surrogates', () => {
  it('drops a stray NUL that is not part of a run', () => {
    expect(normalizeText(`wsl${NUL} --list`)).toBe('wsl --list')
  })

  it('drops every NUL, not just the first', () => {
    expect(normalizeText(`${NUL}a${NUL}b${NUL}`)).toBe('ab')
  })

  it('drops a lone high surrogate', () => {
    expect(normalizeText('bad \uD800 half')).toBe('bad  half')
  })

  it('drops a lone low surrogate', () => {
    expect(normalizeText('bad \uDC00 half')).toBe('bad  half')
  })

  it('keeps valid surrogate pairs — real characters must survive', () => {
    expect(normalizeText('brain \u{1F9E0} emoji')).toBe('brain \u{1F9E0} emoji')
  })

  it('drops a reversed (low-then-high) surrogate pair as two lone halves', () => {
    expect(normalizeText(`a\uDC00\uD800b`)).toBe('ab')
  })

  it('leaves ordinary text untouched', () => {
    expect(normalizeText('nothing to strip')).toBe('nothing to strip')
  })

  // The literal six characters \u0000 are legitimate content — a code sample,
  // say — and must survive. Only the real character is a storage problem.
  it('leaves the literal escape sequence alone', () => {
    expect(normalizeText(String.raw`\u0000`)).toBe(String.raw`\u0000`)
  })

  it('keeps other control characters, which postgres stores fine', () => {
    expect(normalizeText('a\tb\nc')).toBe('a\tb\nc')
  })
})

describe('normalizeDeep', () => {
  it('normalizes strings wherever they sit in the tree', () => {
    const input = {
      output: utf16le('WSL version: 2.6.1.0'),
      nested: { list: [`a${NUL}`, 'clean', { deep: '\uD800' }] },
    }
    expect(normalizeDeep(input)).toEqual({
      output: 'WSL version: 2.6.1.0',
      nested: { list: ['a', 'clean', { deep: '' }] },
    })
  })

  // jsonb rejects NULs in keys exactly like values, and JSON.stringify
  // replacers cannot rename keys — this is why toJson walks the tree instead.
  it('normalizes object keys too', () => {
    expect(normalizeDeep({ [`k${NUL}ey`]: 'v' })).toEqual({ key: 'v' })
  })

  // Keys that differ only by NULs collapse. The clean key must win, whatever
  // order the entries arrive in — a repaired key never overwrites a value
  // that is already present.
  it('lets the clean key win when a repaired key collides with it', () => {
    expect(normalizeDeep({ [`a${NUL}`]: 1, a: 2 })).toEqual({ a: 2 })
    expect(normalizeDeep({ a: 2, [`a${NUL}`]: 1 })).toEqual({ a: 2 })
  })

  it('collides deterministically among repaired keys: first one wins', () => {
    expect(normalizeDeep({ [`a${NUL}`]: 1, [`a${NUL}${NUL}`]: 3 })).toEqual({ a: 1 })
  })

  it('resolves the reviewer counterexample with the clean value intact', () => {
    expect(normalizeDeep({ [`a${NUL}`]: 1, a: 2, [`a${NUL}${NUL}`]: 3 })).toEqual({ a: 2 })
  })

  it('passes non-strings through untouched', () => {
    const input = { n: 42, b: true, nil: null, list: [1, 2] }
    expect(normalizeDeep(input)).toEqual(input)
  })

  it('leaves class instances like Date alone', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    expect(normalizeDeep({ at: now }).at).toBe(now)
  })
})
