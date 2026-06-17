import { describe, expect, it } from 'vitest';
import { resolveInitialSessionTitle } from '../session-title-service.js';

describe('resolveInitialSessionTitle', () => {
  it('uses goalContent from session metadata', () => {
    expect(resolveInitialSessionTitle({
      sessionMetadata: { goalContent: '你好，帮我看看认证模块' },
      prompt: '## User Goal\nIgnored',
    })).toBe('你好，帮我看看认证模块');
  });

  it('truncates long user input', () => {
    const long = 'a'.repeat(100);
    const title = resolveInitialSessionTitle({
      sessionMetadata: { goalContent: long },
      prompt: '',
    });
    expect(title).toHaveLength(80);
    expect(title?.endsWith('…')).toBe(true);
  });

  it('uses short non-system prompts as provisional titles', () => {
    expect(resolveInitialSessionTitle({
      sessionMetadata: null,
      prompt: 'Plan a bounded implementation slice.',
    })).toBe('Plan a bounded implementation slice.');
  });

  it('skips long system-style prompts without extractable goal', () => {
    expect(resolveInitialSessionTitle({
      sessionMetadata: null,
      prompt: 'You are a Goal Agent\n\n## Instructions\nDo things',
    })).toBeNull();
  });
});
