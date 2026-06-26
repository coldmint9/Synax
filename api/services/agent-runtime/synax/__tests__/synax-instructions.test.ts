import { describe, expect, it } from 'vitest';
import { stripPromptBloat, truncateForPrompt } from '../synax-instructions.js';

describe('stripPromptBloat', () => {
  it('removes HeroUI docs index block', () => {
    const input = [
      '# Project',
      '<!-- HEROUI-REACT-AGENTS-MD-START -->',
      'huge index content',
      '<!-- HEROUI-REACT-AGENTS-MD-END -->',
      '## Architecture',
      'Keep this',
    ].join('\n');

    const output = stripPromptBloat(input);
    expect(output).not.toContain('HEROUI-REACT-AGENTS-MD');
    expect(output).toContain('## Architecture');
    expect(output).toContain('Keep this');
  });
});

describe('truncateForPrompt', () => {
  it('appends truncation marker when over budget', () => {
    const output = truncateForPrompt('x'.repeat(100), 50);
    expect(output.length).toBeLessThan(100);
    expect(output).toContain('[...truncated for context budget...]');
  });
});
