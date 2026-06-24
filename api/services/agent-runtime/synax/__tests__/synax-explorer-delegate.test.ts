import { describe, expect, it } from 'vitest';
import {
  buildExplorerSubagentPrompt,
  shouldWrapExplorerDelegatePrompt,
} from '../synax-explorer-delegate.js';

describe('buildExplorerSubagentPrompt', () => {
  it('wraps investigation with wiki-first playbook', () => {
    const prompt = buildExplorerSubagentPrompt('How is auth implemented?');
    expect(prompt).toContain('## Investigation Task');
    expect(prompt).toContain('How is auth implemented?');
    expect(prompt).toContain('## Explorer Playbook (mandatory)');
    expect(prompt).toContain('wiki.search_batch');
    expect(prompt).toContain('wiki.read_section');
  });
});

describe('shouldWrapExplorerDelegatePrompt', () => {
  it('wraps only the builtin explorer profile', () => {
    expect(shouldWrapExplorerDelegatePrompt('explorer')).toBe(true);
    expect(shouldWrapExplorerDelegatePrompt('reviewer')).toBe(false);
    expect(shouldWrapExplorerDelegatePrompt('wiki-explorer')).toBe(false);
  });
});
