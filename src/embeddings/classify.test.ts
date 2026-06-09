import { describe, it, expect } from 'vitest'
import { classifyAutomated, isAutomated } from './classify.js'

describe('classifyAutomated', () => {
  it('flags Slack monitoring assistant sessions', () => {
    expect(classifyAutomated('You are a Slack monitoring assistant. Your job is to categorize.')).toBeTruthy()
  })

  it('flags curiosity curator sessions', () => {
    expect(classifyAutomated('You are a curiosity curator helping @hypnodroid discover discussions.')).toBeTruthy()
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
