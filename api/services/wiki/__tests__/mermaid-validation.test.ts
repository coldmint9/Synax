import { describe, it, expect } from 'vitest';
import {
  detectDiagramKind,
  diagramKindMatchesRequirement,
  extractMermaidBlocks,
  normalizeMermaidInput,
  validateAllMermaidInMarkdown,
  validateMermaidCode,
  validateMermaidInput,
} from '../mermaid-validation.js';

describe('normalizeMermaidInput', () => {
  it('strips mermaid fences', () => {
    const input = '```mermaid\nflowchart TD\n  A --> B\n```';
    expect(normalizeMermaidInput(input)).toBe('flowchart TD\n  A --> B');
  });

  it('returns trimmed raw code unchanged', () => {
    expect(normalizeMermaidInput('sequenceDiagram\n  A->>B: hi')).toBe('sequenceDiagram\n  A->>B: hi');
  });
});

describe('extractMermaidBlocks', () => {
  it('extracts multiple blocks with line numbers', () => {
    const md = [
      '# Title',
      '',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '',
      '## Second',
      '```mermaid',
      'sequenceDiagram',
      '  A->>B: hi',
      '```',
    ].join('\n');

    const blocks = extractMermaidBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].index).toBe(0);
    expect(blocks[0].startLine).toBe(3);
    expect(blocks[0].code).toContain('flowchart TD');
    expect(blocks[1].index).toBe(1);
    expect(blocks[1].startLine).toBe(9);
  });
});

describe('detectDiagramKind', () => {
  it('maps graph to flowchart', () => {
    expect(detectDiagramKind('graph TD\n  A --> B')).toBe('flowchart');
  });

  it('detects sequence and er diagrams', () => {
    expect(detectDiagramKind('sequenceDiagram\n  A->>B: x')).toBe('sequence');
    expect(detectDiagramKind('erDiagram\n  USER ||--o{ ORDER : places')).toBe('er');
  });

  it('detects stateDiagram-v2', () => {
    expect(detectDiagramKind('stateDiagram-v2\n  idle --> running')).toBe('state');
  });
});

describe('diagramKindMatchesRequirement', () => {
  it('matches flowchart requirement for graph syntax', () => {
    expect(diagramKindMatchesRequirement('flowchart', 'flowchart')).toBe(true);
    expect(diagramKindMatchesRequirement('sequence', 'flowchart')).toBe(false);
  });
});

describe('validateMermaidCode', () => {
  it('accepts valid flowchart', async () => {
    const result = await validateMermaidCode('flowchart TD\n  A --> B');
    expect(result.ok).toBe(true);
    expect(result.diagramKind).toBe('flowchart');
  });

  it('accepts valid sequenceDiagram', async () => {
    const result = await validateMermaidCode('sequenceDiagram\n  Alice->>Bob: hello');
    expect(result.ok).toBe(true);
    expect(result.diagramKind).toBe('sequence');
  });

  it('accepts valid erDiagram', async () => {
    const result = await validateMermaidCode('erDiagram\n  USER ||--o{ ORDER : places');
    expect(result.ok).toBe(true);
    expect(result.diagramKind).toBe('er');
  });

  it('accepts valid stateDiagram-v2', async () => {
    const result = await validateMermaidCode('stateDiagram-v2\n  idle --> running');
    expect(result.ok).toBe(true);
    expect(result.diagramKind).toBe('state');
  });

  it('rejects unquoted parentheses in node labels', async () => {
    const result = await validateMermaidCode('flowchart TD\n  A[foo(bar)] --> B');
    expect(result.ok).toBe(false);
    expect(result.hints?.some((h) => h.includes('double quotes'))).toBe(true);
  });

  it('rejects empty diagram', async () => {
    const result = await validateMermaidCode('   ');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('rejects unrecognized header', async () => {
    const result = await validateMermaidCode('not a diagram');
    expect(result.ok).toBe(false);
  });
});

describe('validateAllMermaidInMarkdown', () => {
  it('returns formatted errors for invalid blocks', async () => {
    const md = [
      '## Diagram',
      '```mermaid',
      'flowchart TD',
      '  A[bad(paren)] --> B',
      '```',
    ].join('\n');

    const errors = await validateAllMermaidInMarkdown(md);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/Mermaid block #1/);
    expect(errors[0]).toMatch(/line 2/);
    expect(errors[0]).toMatch(/Hint:/);
  });

  it('returns no errors for valid markdown', async () => {
    const md = [
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
    ].join('\n');

    const errors = await validateAllMermaidInMarkdown(md);
    expect(errors).toEqual([]);
  });
});

describe('validateMermaidInput', () => {
  it('validates all blocks when markdown is passed', async () => {
    const md = [
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '```mermaid',
      'sequenceDiagram',
      '  A->>B: hi',
      '```',
    ].join('\n');

    const results = await validateMermaidInput({ markdown: md });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('validates single code input with fences stripped', async () => {
    const results = await validateMermaidInput({
      code: '```mermaid\nflowchart TD\n  A --> B\n```',
    });
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });
});
