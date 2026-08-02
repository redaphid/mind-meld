import { describe, it, expect } from 'vitest'
import { classifyAutomated, isAutomated, classifyNoise } from './classify.js'

// The parser strips scaffolding on the way in, but ~800 messages were stored
// before it did. Until the backfill runs, those rows still hold raw wrappers —
// so the classifier is the second line of defence that keeps them out of the
// index (issue #37).
describe('classifyNoise: harness scaffolding (issue #37)', () => {
  it('rejects a wrapper-only message that clears the length floor', () => {
    // 70 chars of pure markup — long enough that the too-short rule misses it,
    // which is precisely how these got embedded in the first place.
    const raw = '<command-message>vj</command-message>\n<command-name>/vj</command-name>'
    expect(raw.length).toBeGreaterThan(50)
    expect(classifyNoise(raw)).toBe('scaffolding-only')
  })

  it('rejects a message that is only a system-reminder', () => {
    expect(
      classifyNoise(
        '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
      )
    ).toBe('scaffolding-only')
  })

  it('keeps a command that carried real user content', () => {
    const raw =
      '<command-name>/vibej</command-name>\n<command-args>' +
      'float sdSphere( vec3 p, float s ) { return length(p)-s; }</command-args>'
    expect(classifyNoise(raw)).toBeNull()
  })

  it('still judges length on the real content, not the markup', () => {
    // Stripped this is 'hi' — genuinely too short. The wrapper must not be
    // allowed to pad it over the threshold.
    const raw = '<command-name>/ask</command-name>\n<command-args>hi</command-args>'
    expect(raw.length).toBeGreaterThan(50)
    expect(classifyNoise(raw)).toMatch(/^too-short:/)
  })

  it('leaves ordinary long conversation alone', () => {
    expect(classifyNoise('Can you explain how the embedding backlog drains? '.repeat(3))).toBeNull()
  })
})

describe('classifyAutomated', () => {
  it('flags Slack monitoring assistant sessions', () => {
    expect(classifyAutomated('You are a Slack monitoring assistant. Your job is to categorize.')).toBeTruthy()
  })

  it('flags curiosity curator sessions', () => {
    expect(classifyAutomated('You are a curiosity curator helping @someone discover discussions.')).toBeTruthy()
  })

  it('flags MCP availability checker sessions', () => {
    expect(classifyAutomated('You are an MCP availability checker. Call each tool ONCE.')).toBeTruthy()
  })

  it('flags huddle transcript sessions', () => {
    expect(classifyAutomated('Huddle in #security-task-force - 6/8/2026')).toBeTruthy()
  })

  it('matches only on the first line of a multi-line title', () => {
    expect(classifyAutomated('You are a curiosity curator\nmore prompt text here')).toBeTruthy()
  })

  it('does not flag the prefix appearing on a later line', () => {
    expect(classifyAutomated('Fix the bug\nYou are a Slack monitoring assistant')).toBeNull()
  })

  it('does not flag genuine interactive sessions', () => {
    expect(classifyAutomated('Help me debug the FTS5 query in ears')).toBeNull()
  })

  it('returns null for a null title', () => {
    expect(classifyAutomated(null)).toBeNull()
  })

  it('isAutomated reflects classifyAutomated as a boolean', () => {
    expect(isAutomated('You are a Slack monitoring assistant')).toBe(true)
    expect(isAutomated('Refactor the search arms')).toBe(false)
    expect(isAutomated(null)).toBe(false)
  })
})
