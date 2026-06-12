import { describe, it, expect } from 'vitest';
import { cjkSeparate, extractSearchText } from '../wiki-fts.js';

describe('wiki-fts', () => {
  it('cjkSeparate inserts spaces around CJK characters', () => {
    expect(cjkSeparate('认证')).toBe('认 证');
  });

  it('extractSearchText strips markdown and tokenizes CJK', () => {
    const text = extractSearchText('## Hello 世界\n\nSome **bold** text.');
    expect(text).toContain('Hello');
    expect(text).toContain('世 界');
    expect(text).not.toContain('**');
  });
});
