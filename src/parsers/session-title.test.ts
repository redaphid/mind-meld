import { describe, it, expect } from 'vitest';
import {
  deriveSessionTitle,
  stripCommandWrappers,
  isCommandTitle,
  contentJsonHasToolResult,
} from './session-title.js';

const user = (contentText: string, isToolResult = false) => ({
  role: 'user',
  contentText,
  isToolResult,
});

describe('stripCommandWrappers', () => {
  it('removes command-name/message/args blocks', () => {
    const text =
      '<command-name>/deploy</command-name>\n<command-message>deploy</command-message>\n<command-args>--prod</command-args>';
    expect(stripCommandWrappers(text)).toBe('');
  });

  it('removes local-command output blocks', () => {
    expect(
      stripCommandWrappers('<local-command-stdout>ok</local-command-stdout>')
    ).toBe('');
  });

  it('removes system-reminder blocks', () => {
    expect(
      stripCommandWrappers('<system-reminder>internal context</system-reminder>')
    ).toBe('');
  });

  it('keeps human text mixed with wrappers', () => {
    const text =
      '<command-name>/review</command-name>\nPlease focus on the auth module\n<system-reminder>noise</system-reminder>';
    expect(stripCommandWrappers(text)).toBe('Please focus on the auth module');
  });

  it('removes dangling unclosed wrapper tags', () => {
    expect(stripCommandWrappers('<local-command-stdout>')).toBe('');
  });
});

describe('deriveSessionTitle', () => {
  it('uses the first human-typed user message', () => {
    const title = deriveSessionTitle([
      user('fix the login bug'),
      { role: 'assistant', contentText: 'Sure, looking at it.' },
    ]);
    expect(title).toBe('fix the login bug');
  });

  it('skips command-XML-only messages and titles from the next human message', () => {
    const title = deriveSessionTitle([
      user('<command-name>/context</command-name><command-message>context</command-message>'),
      { role: 'assistant', contentText: 'Loaded context.' },
      user('now refactor the sync module'),
    ]);
    expect(title).toBe('now refactor the sync module');
  });

  it('strips wrappers when the first real message mixes XML and human text', () => {
    const title = deriveSessionTitle([
      user('<command-name>/review</command-name>\ncheck the retry logic please'),
    ]);
    expect(title).toBe('check the retry logic please');
  });

  it('skips system-reminder-only messages', () => {
    const title = deriveSessionTitle([
      user('<system-reminder>hook context</system-reminder>'),
      user('what does the orchestrator do?'),
    ]);
    expect(title).toBe('what does the orchestrator do?');
  });

  it('skips tool_result user messages', () => {
    const title = deriveSessionTitle([
      user('<command-name>/foo</command-name>'),
      user('tool output text that is not a prompt', true),
      user('real human question'),
    ]);
    expect(title).toBe('real human question');
  });

  it('ignores assistant messages when picking the title', () => {
    const title = deriveSessionTitle([
      { role: 'assistant', contentText: 'assistant preamble' },
      user('human prompt'),
    ]);
    expect(title).toBe('human prompt');
  });

  it('falls back to the first message content when no human text exists', () => {
    const commandOnly = '<command-name>/warmup</command-name>';
    const title = deriveSessionTitle([user(commandOnly)]);
    expect(title).toBe(commandOnly);
  });

  it('returns undefined for empty input', () => {
    expect(deriveSessionTitle([])).toBeUndefined();
  });

  it('caps titles at 200 chars (title column limit)', () => {
    const title = deriveSessionTitle([user('x'.repeat(500))]);
    expect(title).toHaveLength(200);
  });
});

describe('isCommandTitle', () => {
  it('flags command-name titles', () => {
    expect(isCommandTitle('<command-name>/deploy</command-name>...')).toBe(true);
  });

  it('flags local-command titles', () => {
    expect(isCommandTitle('<local-command-stdout>ok</local-command-stdout>')).toBe(true);
  });

  it('flags system-reminder titles', () => {
    expect(isCommandTitle('<system-reminder>x</system-reminder>')).toBe(true);
  });

  it('does not flag normal titles', () => {
    expect(isCommandTitle('fix the login bug')).toBe(false);
    expect(isCommandTitle(null)).toBe(false);
  });
});

describe('contentJsonHasToolResult', () => {
  it('detects tool_result content blocks', () => {
    expect(
      contentJsonHasToolResult({ role: 'user', content: [{ type: 'tool_result', content: 'ok' }] })
    ).toBe(true);
  });

  it('returns false for string content', () => {
    expect(contentJsonHasToolResult({ role: 'user', content: 'hello' })).toBe(false);
  });

  it('returns false for text-only arrays and bad input', () => {
    expect(contentJsonHasToolResult({ content: [{ type: 'text', text: 'hi' }] })).toBe(false);
    expect(contentJsonHasToolResult(null)).toBe(false);
    expect(contentJsonHasToolResult('str')).toBe(false);
  });
});
