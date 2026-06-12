import { describe, it, expect } from 'vitest';
import { validateDocumentQuality, proseCharCount } from '../document-quality-gates.js';

function longProse(text: string) {
  return {
    blockType: 'prose' as const,
    content: { segments: [{ type: 'text', value: text }] },
  };
}

function heading(level: 1 | 2 | 3, text: string) {
  return { blockType: 'heading' as const, content: { level, text } };
}

describe('validateDocumentQuality', () => {
  it('rejects module docs with thin prose', () => {
    const short = 'x'.repeat(100);
    const blocks = [
      heading(1, 'Runtime'),
      heading(2, 'Overview'),
      longProse(short),
      heading(2, 'API'),
      longProse(short),
      heading(2, 'Flow'),
      longProse(short),
      { blockType: 'signature' as const, content: { language: 'ts', tokens: [{ type: 'name', value: 'run' }], source: { file: 'a.ts', line: 1 } } },
      { blockType: 'table' as const, content: { headers: [{ key: 'k', label: 'K' }], rows: [{ k: 'v' }] } },
      { blockType: 'callout' as const, content: { level: 'important', body: [{ type: 'text', value: 'Design choice because of latency budget and isolation requirements in multi-tenant sessions.' }] } },
      { blockType: 'list' as const, content: { ordered: false, items: [{ segments: [{ type: 'text', value: 'depends on store' }] }] } },
      heading(2, 'Extra'),
      longProse(short),
    ];

    const errors = validateDocumentQuality('module', blocks, { minContentLength: 350 });
    expect(errors.some(e => e.includes('prose'))).toBe(true);
  });

  it('accepts a rich module document skeleton', () => {
    const rich = 'A'.repeat(420);
    const blocks = [
      heading(1, 'Runtime'),
      heading(2, 'Design Intent'),
      longProse(rich),
      heading(2, 'Core Concepts'),
      longProse(rich),
      heading(2, 'Runtime Behavior'),
      longProse(rich),
      { blockType: 'signature' as const, content: { language: 'ts', tokens: [{ type: 'name', value: 'streamRun' }], source: { file: 'runtime.ts', line: 10 } } },
      { blockType: 'table' as const, content: { headers: [{ key: 'method', label: 'Method' }], rows: [{ method: 'streamRun' }] } },
      { blockType: 'callout' as const, content: { level: 'important', body: [{ type: 'text', value: 'Sessions are isolated to prevent tool permission bleed across concurrent runs in the same workspace. This trades memory for safety and matches the one-session-one-streamRun invariant enforced in loop-runtime at commit time.' }] } },
      { blockType: 'list' as const, content: { ordered: false, items: [{ segments: [{ type: 'text', value: 'agent-runtime' }] }] } },
    ];

    const errors = validateDocumentQuality('module', blocks, { minContentLength: 350 });
    expect(errors).toEqual([]);
  });

  it('requires sequence diagram for flow docs', () => {
    const rich = 'B'.repeat(420);
    const blocks = [
      heading(1, 'Login Flow'),
      heading(2, 'Overview'),
      longProse(rich),
      heading(2, 'Steps'),
      longProse(rich),
      { blockType: 'diagram' as const, content: { diagramType: 'flowchart', code: 'graph TD; A-->B' } },
      { blockType: 'callout' as const, content: { level: 'warn', body: [{ type: 'text', value: 'Failed auth attempts are rate-limited per IP and user id to reduce brute-force risk.' }] } },
      { blockType: 'list' as const, content: { ordered: true, items: [{ segments: [{ type: 'text', value: 'auth service' }] }] } },
    ];

    const errors = validateDocumentQuality('flow', blocks, { minContentLength: 350 });
    expect(errors.some(e => e.includes('sequence diagram'))).toBe(true);
  });
});

describe('proseCharCount', () => {
  it('sums segment text lengths', () => {
    expect(proseCharCount({
      segments: [
        { type: 'text', value: 'hello' },
        { type: 'code', value: 'world()' },
      ],
    })).toBe(12);
  });
});
