import { describe, it, expect } from 'vitest'
import { classifyAutomated, isAutomated, classifyNoise, minContentChars } from './classify.js'

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

// The 50-character floor is a coding heuristic: under it, a transcript is
// almost always tool chatter. A conversation is the opposite -- the short line
// is the content. Applying the coding floor to chat sources discarded the
// majority of every chat corpus indexed here behind permanent UNEMBEDDABLE
// markers, which is why the message tier of semantic search returned nothing
// for them.
describe('classifyNoise: the length floor follows the data class', () => {
  // Synthetic, but shaped like the traffic that was being dropped: ordinary
  // chat lines between 10 and 50 characters. Deliberately invented rather than
  // copied from a real thread -- this repository is public, and a regression
  // fixture is not a reason to publish somebody's messages.
  const shortChatLines = [
    'What time does it start?',
    'omg I cannot wait for this',
    'this is going to be so much fun',
    'yes same here, super hyped!',
    'that track absolutely goes hard',
  ]

  it.each(shortChatLines)('keeps a chat line the coding floor threw away: %s', (dm) => {
    expect(dm.length).toBeLessThan(50)
    // What the bug did.
    expect(classifyNoise(dm, 'coding')).toMatch(/^too-short:/)
    // What it must do now.
    expect(classifyNoise(dm, 'personal')).toBeNull()
  })

  it('still applies the aggressive floor to coding data', () => {
    expect(classifyNoise('Exit code 0 and done', 'coding')).toMatch(/^too-short:/)
  })

  it('treats an unspecified data class as coding, so existing callers are unchanged', () => {
    const short = 'Where is it being held?'
    expect(classifyNoise(short)).toBe(classifyNoise(short, 'coding'))
    expect(classifyNoise(short, null)).toMatch(/^too-short:/)
  })

  it('does not let a conversational class rescue near-empty text', () => {
    // Below the 10-character gate pending.ts already applies in SQL.
    expect(classifyNoise('ok thx', 'personal')).toMatch(/^too-short:/)
  })

  it('judges chat length on stripped content, so markup cannot pad it', () => {
    const raw = '<command-name>/ask</command-name>\n<command-args>hi</command-args>'
    expect(classifyNoise(raw, 'personal')).not.toBeNull()
  })

  it('still applies the noise patterns to conversational data', () => {
    expect(classifyNoise('[Request interrupted by the user before it finished]', 'personal')).toMatch(
      /^pattern:/
    )
  })

  it('presumes any unrecognised class is conversational, not coding', () => {
    // A class added later must not silently inherit the coding floor.
    expect(minContentChars('notes')).toBe(10)
    expect(minContentChars('meetings')).toBe(10)
    expect(minContentChars('a-class-invented-tomorrow')).toBe(10)
    expect(minContentChars('coding')).toBe(50)
    expect(minContentChars('  CODING  ')).toBe(50)
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
