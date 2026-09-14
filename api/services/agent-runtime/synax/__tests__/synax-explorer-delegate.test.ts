import { describe, expect, it } from 'vitest';
import {
  buildExplorerSubagentPrompt,
  shouldWrapExplorerDelegatePrompt,
} from '../synax-explorer-delegate.js';

describe('buildExplorerSubagentPrompt', () => {
  it('wraps a bounded read-only investigation without a fixed tool sequence', () => {
    const prompt = buildExplorerSubagentPrompt('How is auth implemented?');
    expect(prompt).toContain('## Investigation Task');
    expect(prompt).toContain('How is auth implemented?');
    expect(prompt).toContain('## Explorer Playbook');
    expect(prompt).toContain('search code directly');
    expect(prompt).toContain('Stop when the assigned question is answered.');
  });
});

describe('shouldWrapExplorerDelegatePrompt', () => {
  it('wraps only the builtin explorer profile', () => {
    expect(shouldWrapExplorerDelegatePrompt('explorer')).toBe(true);
    expect(shouldWrapExplorerDelegatePrompt('reviewer')).toBe(false);
    expect(shouldWrapExplorerDelegatePrompt('wiki-explorer')).toBe(false);
  });
});
