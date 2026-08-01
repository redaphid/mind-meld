import { describe, it, expect } from 'vitest';
import { decodeProjectPath, extractProjectName } from './claude-messages.js';

describe('decodeProjectPath', () => {
  describe('Unix encodings (leading "-")', () => {
    it('decodes a simple Unix path', () => {
      expect(decodeProjectPath('-Users-hypnodroid-Projects-sibi')).toBe(
        '/Users/hypnodroid/Projects/sibi'
      );
    });

    it('decodes a WSL /home path', () => {
      expect(decodeProjectPath('-home-hypnodroid-projects-sporefall-art')).toBe(
        // Lossy: the hyphen in "sporefall-art" is indistinguishable from a
        // separator. The sync's cwd-based correction repairs this.
        '/home/hypnodroid/projects/sporefall/art'
      );
    });
  });

  describe('Windows encodings (drive letter + "--")', () => {
    it('decodes a Windows path with no interior hyphens', () => {
      expect(decodeProjectPath('D--Projects-sporefall')).toBe('D:/Projects/sporefall');
    });

    it('decodes a lowercase drive letter', () => {
      expect(decodeProjectPath('c--Users-hypnodroid-code')).toBe('c:/Users/hypnodroid/code');
    });

    it('decodes a deeper Windows path', () => {
      expect(decodeProjectPath('C--Users-hypnodroid-source-repos-app')).toBe(
        'C:/Users/hypnodroid/source/repos/app'
      );
    });

    it('is lossy for hyphenated project names (repaired later by session cwd)', () => {
      // "D:\Projects\mind-meld" encodes to "D--Projects-mind-meld"; the hyphen
      // in "mind-meld" cannot be told apart from a separator, so the mechanical
      // decode splits it. This is why sync prefers session.cwd when available.
      expect(decodeProjectPath('D--Projects-mind-meld')).toBe('D:/Projects/mind/meld');
    });
  });

  describe('pass-through', () => {
    it('leaves an already-decoded Unix path alone', () => {
      expect(decodeProjectPath('/home/hypnodroid/projects/foo')).toBe(
        '/home/hypnodroid/projects/foo'
      );
    });

    it('leaves an already-decoded Windows path alone', () => {
      expect(decodeProjectPath('D:/Projects/mind-meld')).toBe('D:/Projects/mind-meld');
    });

    it('leaves a plain name alone', () => {
      expect(decodeProjectPath('myproject')).toBe('myproject');
    });

    it('does not treat a multi-letter prefix before "--" as a drive', () => {
      expect(decodeProjectPath('foo--bar')).toBe('foo--bar');
    });
  });
});

describe('extractProjectName', () => {
  it('extracts the last segment of a Unix path', () => {
    expect(extractProjectName('/Users/hypnodroid/Projects/sibi')).toBe('sibi');
  });

  it('preserves hyphens in the project name', () => {
    expect(extractProjectName('/home/hypnodroid/projects/sporefall-art')).toBe('sporefall-art');
  });

  it('extracts from a forward-slash Windows path', () => {
    expect(extractProjectName('D:/Projects/mind-meld')).toBe('mind-meld');
  });

  it('extracts from a backslash Windows cwd', () => {
    expect(extractProjectName('D:\\Projects\\mind-meld')).toBe('mind-meld');
  });

  it('handles mixed separators', () => {
    expect(extractProjectName('D:\\Projects/mind-meld')).toBe('mind-meld');
  });

  it('returns the input when there are no separators', () => {
    expect(extractProjectName('myproject')).toBe('myproject');
  });
});
