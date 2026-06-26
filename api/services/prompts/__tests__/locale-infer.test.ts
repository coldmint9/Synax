import { describe, expect, it } from 'vitest';
import { inferLocaleFromText, resolvePromptLocale } from '../../prompts/locale-infer.js';

describe('inferLocaleFromText', () => {
  it('detects Chinese text', () => {
    expect(inferLocaleFromText('你好')).toBe('zh');
    expect(inferLocaleFromText('请帮我修复这个模块')).toBe('zh');
  });

  it('returns null for plain English without explicit locale', () => {
    expect(inferLocaleFromText('Fix the auth module')).toBeNull();
  });
});

describe('resolvePromptLocale', () => {
  it('prefers explicit locale over inference', () => {
    expect(resolvePromptLocale('en', '你好')).toBe('en');
  });

  it('falls back to inference then default', () => {
    expect(resolvePromptLocale(undefined, '你好')).toBe('zh');
    expect(resolvePromptLocale(undefined, 'Fix bug')).toBe('en');
  });
});
