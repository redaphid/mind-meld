import { describe, it, expect } from 'vitest'
import { stripNulls } from './postgres.js'

// Postgres rejects U+0000 in text and jsonb alike, failing the whole INSERT.
// Transcripts hit this legitimately whenever a WSL command's UTF-16 output is
// recorded, so sanitising is what keeps one bad line from failing a session.
const NUL = String.fromCharCode(0)

describe('stripNulls', () => {
  it('drops NUL characters', () => {
    expect(stripNulls(`wsl${NUL} --list`)).toBe('wsl --list')
  })

  it('drops every NUL, not just the first', () => {
    expect(stripNulls(`${NUL}a${NUL}b${NUL}`)).toBe('ab')
  })

  it('leaves ordinary text untouched', () => {
    expect(stripNulls('nothing to strip')).toBe('nothing to strip')
  })

  // The literal six characters \u0000 are legitimate content — a code sample,
  // say — and must survive. Only the real character is a storage problem.
  it('leaves the escape sequence itself alone', () => {
    expect(stripNulls(String.raw`\u0000`)).toBe(String.raw`\u0000`)
  })

  it('keeps other control characters, which postgres stores fine', () => {
    expect(stripNulls('a\tb\nc')).toBe('a\tb\nc')
  })
})
