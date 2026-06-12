import { describe, it, expect } from 'vitest';
import { sanitizeOutline } from '../tools/outline-sanitize.js';

const q1 = 'What state transitions does the auth login flow have?';
const q2 = 'How are session tokens persisted and invalidated?';

describe('sanitizeOutline', () => {
  it('dedupes ids and strips invalid paths', () => {
    const valid = new Set(['a.ts']);
    const out = sanitizeOutline(
      [
        { id: 'dup', docType: 'module', title: 'A', targetFiles: ['a.ts', 'b.ts'], keyQuestions: [' q1 ', ''] },
        { id: 'dup', docType: 'module', title: 'B', targetFiles: [], keyQuestions: [] },
      ],
      valid,
    );
    expect(out.map(d => d.id)).toEqual(['dup', 'dup-x']);
    expect(out[0].targetFiles).toEqual(['a.ts']);
    expect(out[0].keyQuestions).toEqual(['q1']);
  });

  it('preserves parentId when present', () => {
    const valid = new Set(['a.ts']);
    const out = sanitizeOutline(
      [
        { id: 'root', docType: 'landscape', title: 'Overview', targetFiles: ['a.ts'], keyQuestions: [q1, q2] },
        { id: 'child', docType: 'module', title: 'Auth', parentId: 'root', targetFiles: ['a.ts'], keyQuestions: [q1, q2] },
      ],
      valid,
    );
    expect(out[0].parentId).toBeUndefined();
    expect(out[1].parentId).toBe('root');
  });

  it('omits empty parentId', () => {
    const valid = new Set(['a.ts']);
    const out = sanitizeOutline(
      [{ id: 'root', docType: 'landscape', title: 'Overview', parentId: '  ', targetFiles: ['a.ts'], keyQuestions: [q1, q2] }],
      valid,
    );
    expect(out[0].parentId).toBeUndefined();
  });

  it('clears targetFiles and keyQuestions for section nodes', () => {
    const valid = new Set(['a.ts']);
    const out = sanitizeOutline(
      [{ id: 'sec', nodeKind: 'section', title: 'Core Modules', targetFiles: ['a.ts'], keyQuestions: [q1, q2] }],
      valid,
    );
    expect(out[0].nodeKind).toBe('section');
    expect(out[0].targetFiles).toEqual([]);
    expect(out[0].keyQuestions).toEqual([]);
  });
});
