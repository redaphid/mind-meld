import { describe, it, expect } from 'vitest';
import { normalizeText, normalizeDeep } from './text-encoding.js';

const NUL = String.fromCharCode(0);

/** "WSL version: 2.6.1.0" as wsl.exe emits it: UTF-16LE read as UTF-8. */
const utf16le = (s: string) => s.split('').join(NUL) + NUL;

describe('normalizeText', () => {
  it('decodes UTF-16LE console output back to plain text', () => {
    expect(normalizeText(utf16le('WSL version: 2.6.1.0'))).toBe('WSL version: 2.6.1.0');
  });

  it('strips stray NULs that are not part of a UTF-16LE run', () => {
    expect(normalizeText(`before${NUL}after`)).toBe('beforeafter');
  });

  it('leaves clean text untouched', () => {
    const clean = 'const NAME = "café ☕";';
    expect(normalizeText(clean)).toBe(clean);
  });

  it('preserves valid surrogate pairs', () => {
    expect(normalizeText('emoji 🎉 here')).toBe('emoji 🎉 here');
  });

  it('strips a lone surrogate', () => {
    expect(normalizeText(`truncated ${String.fromCharCode(0xd83c)}`)).toBe('truncated ');
  });

  it('leaves no NUL in the output', () => {
    expect(normalizeText(utf16le('NAME STATE'))).not.toContain(NUL);
  });
});

describe('normalizeDeep', () => {
  it('normalizes nested tool_result content', () => {
    const parsed = {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: utf16le('NAME STATE VERSION') }],
      },
    };

    const out = normalizeDeep(parsed);

    expect(out.message.content[0].content).toBe('NAME STATE VERSION');
    expect(JSON.stringify(out)).not.toContain('u0000');
  });

  it('passes through non-string values unchanged', () => {
    const parsed = { n: 42, b: true, nil: null, arr: [1, 2] };
    expect(normalizeDeep(parsed)).toEqual({ n: 42, b: true, nil: null, arr: [1, 2] });
  });
});
