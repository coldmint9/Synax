import { describe, expect, it } from 'vitest';
import { buildWikiPrompt } from '../wiki-prompt-builder.js';
import { WIKI_AUTHORING_BUILTIN_BODY } from '../generated/wiki-authoring-builtin.js';
import type { WikiOutlineEntry } from '../wiki-loop-tools.js';

const entry: WikiOutlineEntry = {
  id: 'doc-1',
  nodeKind: 'document',
  docType: 'module',
  title: '会话编排层',
  sortOrder: 1,
  targetFiles: ['api/services/agent-runtime/loop-runtime.ts'],
  keyQuestions: ['streamRun 有哪些状态转换？'],
};

describe('buildWikiPrompt — document-writer', () => {
  const prompt = buildWikiPrompt({
    role: 'document-writer',
    languages: 'TypeScript(120)',
    locale: 'zh',
    documentEntry: entry,
    documentContext: 'excerpt placeholder',
  });

  it('injects the authoring guide body', () => {
    expect(prompt).toContain(WIKI_AUTHORING_BUILTIN_BODY);
  });

  it('still carries the per-document task context', () => {
    expect(prompt).toContain('## Current Document');
    expect(prompt).toContain('会话编排层');
    expect(prompt).toContain('streamRun 有哪些状态转换？');
    expect(prompt).toContain('api/services/agent-runtime/loop-runtime.ts');
    expect(prompt).toContain('## Code Context');
    expect(prompt).toContain('excerpt placeholder');
  });

  it('still carries the language directive', () => {
    expect(prompt).toContain('## Language Output Directive');
  });

  it('no longer duplicates the relocated hardcoded sections', () => {
    expect(prompt).not.toContain('You are a senior software architect writing internal design specifications');
    expect(prompt).not.toContain('## Markdown Syntax (use exactly these patterns)');
    expect(prompt).not.toContain('BAD (README depth)');
  });

  it('has no triple blank lines from dropped segments', () => {
    expect(prompt).not.toMatch(/\n{4}/);
  });
});

describe('buildWikiPrompt — writer role is untouched', () => {
  const prompt = buildWikiPrompt({
    role: 'writer',
    languages: 'TypeScript(120)',
    locale: 'zh',
    outline: [entry],
  });

  it('keeps the legacy writer identity and quality text', () => {
    expect(prompt).toContain('You are a technical documentation engineer.');
    expect(prompt).toContain('## Quality Requirements');
    expect(prompt).toContain('## Writing Strategy');
  });

  it('does not receive the authoring guide', () => {
    expect(prompt).not.toContain(WIKI_AUTHORING_BUILTIN_BODY);
  });
});

describe('buildWikiPrompt — planner role is untouched', () => {
  it('keeps the planner identity and outline workflow', () => {
    const prompt = buildWikiPrompt({
      role: 'planner',
      languages: 'TypeScript(120)',
      locale: 'zh',
    });
    expect(prompt).toContain('You are a senior software architect.');
    expect(prompt).toContain('### One-Shot Outline Workflow');
    expect(prompt).not.toContain(WIKI_AUTHORING_BUILTIN_BODY);
  });
});
