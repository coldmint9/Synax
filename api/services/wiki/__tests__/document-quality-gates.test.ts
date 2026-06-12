import { describe, it, expect } from 'vitest';
import { validateDocumentQuality } from '../document-quality-gates.js';

const baseMd = [
  '# Title',
  '## Section One',
  '## Section Two',
  'Some prose explaining the design in enough detail to pass length checks for landscape documents.',
  '| Col | Val |',
  '| --- | --- |',
  '| a | b |',
  '- item one',
  '- item two',
].join('\n');

describe('validateDocumentQuality', () => {
  it('passes a well-formed landscape document', () => {
    const refs = [{ filePath: 'src/index.ts' }];
    const errors = validateDocumentQuality('landscape', baseMd.repeat(7), refs);
    expect(errors).toEqual([]);
  });

  it('fails when references are empty', () => {
    const errors = validateDocumentQuality('landscape', baseMd.repeat(3), []);
    expect(errors.some(e => e.includes('references'))).toBe(true);
  });

  it('requires mermaid for topology', () => {
    const refs = [{ filePath: 'src/a.ts' }];
    const errors = validateDocumentQuality('topology', baseMd.repeat(3), refs);
    expect(errors.some(e => e.includes('mermaid'))).toBe(true);
  });
});
