import { describe, it, expect } from 'vitest';
import { validateDocumentQuality } from '../document-quality-gates.js';

const proseLine =
  'This subsystem orchestrates the full request lifecycle with explicit state transitions and failure handling at each boundary.';

const baseMd = [
  '# Title',
  '',
  '*One-line subtitle describing scope and integration points for readers who skim headers only.*',
  '',
  '## Section One',
  proseLine,
  proseLine.replace('request lifecycle', 'concurrency model'),
  '',
  '## Section Two',
  proseLine.replace('subsystem', 'module'),
  proseLine.replace('failure handling', 'backpressure semantics'),
  '',
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

  it('counts graph TD as flowchart for topology', () => {
    const refs = [{ filePath: 'src/a.ts' }];
    const withGraph = baseMd + '\n```mermaid\ngraph TD\n  A --> B\n```\n> [!IMPORTANT]\n**Layering** — concrete boundary.';
    const errors = validateDocumentQuality('topology', withGraph.repeat(3), refs);
    expect(errors.some(e => e.includes('flowchart mermaid'))).toBe(false);
  });
});
