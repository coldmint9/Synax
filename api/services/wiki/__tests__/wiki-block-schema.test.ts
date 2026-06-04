import { describe, it, expect } from 'vitest';
import { validateBlockContent, type WikiBlockType } from '../contracts.js';

describe('validateBlockContent', () => {
  it('accepts valid prose block', () => {
    const result = validateBlockContent('prose', {
      segments: [
        { type: 'text', value: 'The agent runtime manages' },
        { type: 'code', value: 'streamRun()' },
        { type: 'text', value: ' lifecycle.' },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects prose block with empty segments', () => {
    const result = validateBlockContent('prose', { segments: [] });
    expect(result.ok).toBe(false);
  });

  it('accepts valid signature block', () => {
    const result = validateBlockContent('signature', {
      language: 'typescript',
      tokens: [
        { type: 'keyword', value: 'async' },
        { type: 'name', value: 'streamRun' },
        { type: 'punctuation', value: '(' },
        { type: 'param', value: 'session' },
        { type: 'punctuation', value: ':' },
        { type: 'type', value: 'AgentSession' },
        { type: 'punctuation', value: ')' },
      ],
      source: { file: 'api/services/agent-runtime/loop.ts', line: 42 },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects signature block without source', () => {
    const result = validateBlockContent('signature', {
      language: 'typescript',
      tokens: [{ type: 'name', value: 'foo' }],
    });
    expect(result.ok).toBe(false);
  });

  it('accepts valid callout block', () => {
    const result = validateBlockContent('callout', {
      level: 'warn',
      title: 'Concurrency Limit',
      body: [
        { type: 'text', value: 'Max 5 concurrent sub-agents per session.' },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts valid table block', () => {
    const result = validateBlockContent('table', {
      headers: [
        { key: 'field', label: 'Field' },
        { key: 'type', label: 'Type' },
      ],
      rows: [
        { field: 'id', type: { type: 'code', value: 'string' } },
        { field: 'status', type: { type: 'code', value: 'SessionStatus' } },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts valid diagram block', () => {
    const result = validateBlockContent('diagram', {
      diagramType: 'flowchart',
      code: 'graph TD\n  A --> B',
      caption: 'Request flow',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts valid list block', () => {
    const result = validateBlockContent('list', {
      ordered: false,
      items: [
        { segments: [{ type: 'code', value: 'llm-runtime' }, { type: 'text', value: ' — provider registry' }] },
        { segments: [{ type: 'code', value: 'context' }, { type: 'text', value: ' — session management' }] },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown block type', () => {
    const result = validateBlockContent('unknown' as WikiBlockType, {});
    expect(result.ok).toBe(false);
  });
});
