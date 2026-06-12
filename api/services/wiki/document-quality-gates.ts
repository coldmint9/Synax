import type { WikiDocType, WikiReference } from './contracts.js';
import { MIN_MARKDOWN_LENGTH } from './tools/contracts.js';

export interface DocumentQualityOptions {
  minContentLength?: number;
}

function countHeadings(markdown: string, level: 2 | 3): number {
  const prefix = '#'.repeat(level) + ' ';
  return markdown.split('\n').filter(line => line.startsWith(prefix)).length;
}

function countMermaidFences(markdown: string, diagramType?: string): number {
  const fences = markdown.match(/```mermaid[\s\S]*?```/g) ?? [];
  if (!diagramType) return fences.length;
  return fences.filter(f => f.toLowerCase().includes(diagramType.toLowerCase())).length;
}

function countTables(markdown: string): number {
  const lines = markdown.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('|') && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      count++;
    }
  }
  return count;
}

function countCodeBlocks(markdown: string): number {
  const all = markdown.match(/```[\s\S]*?```/g) ?? [];
  return all.filter(f => !f.startsWith('```mermaid')).length;
}

function countLists(markdown: string): number {
  return markdown.split('\n').filter(line => /^(\s*[-*+]|\s*\d+\.)\s+/.test(line)).length;
}

const STRUCTURE_REQUIREMENTS: Record<
  WikiDocType,
  {
    minLevel2Headings: number;
    minTables: number;
    minMermaid: number;
    minCodeBlocks: number;
    minListItems: number;
    requireDiagramType?: string;
  }
> = {
  landscape: { minLevel2Headings: 2, minTables: 1, minMermaid: 0, minCodeBlocks: 0, minListItems: 1 },
  topology: { minLevel2Headings: 2, minTables: 1, minMermaid: 1, minCodeBlocks: 0, minListItems: 0, requireDiagramType: 'flowchart' },
  module: { minLevel2Headings: 3, minTables: 1, minMermaid: 0, minCodeBlocks: 1, minListItems: 1 },
  flow: { minLevel2Headings: 2, minTables: 0, minMermaid: 1, minCodeBlocks: 0, minListItems: 1, requireDiagramType: 'sequence' },
  data: { minLevel2Headings: 2, minTables: 1, minMermaid: 1, minCodeBlocks: 0, minListItems: 0, requireDiagramType: 'er' },
};

export function validateDocumentQuality(
  docType: WikiDocType,
  markdown: string,
  references: WikiReference[],
  options: DocumentQualityOptions = {},
): string[] {
  const minContentLength = options.minContentLength ?? MIN_MARKDOWN_LENGTH[docType] ?? 350;
  const errors: string[] = [];
  const requirements = STRUCTURE_REQUIREMENTS[docType];
  const stripped = markdown.replace(/```[\s\S]*?```/g, ' ').replace(/^#{1,6}\s+/gm, '').trim();

  if (stripped.length < minContentLength) {
    errors.push(`Markdown body too short: ${stripped.length} chars (minimum ${minContentLength}).`);
  }

  const level2 = countHeadings(markdown, 2);
  if (level2 < requirements.minLevel2Headings) {
    errors.push(`Need at least ${requirements.minLevel2Headings} ## headings (found ${level2}).`);
  }

  const tables = countTables(markdown);
  if (tables < requirements.minTables) {
    errors.push(`Need at least ${requirements.minTables} markdown table(s) (found ${tables}).`);
  }

  const mermaid = requirements.requireDiagramType
    ? countMermaidFences(markdown, requirements.requireDiagramType)
    : countMermaidFences(markdown);
  if (mermaid < requirements.minMermaid) {
    const hint = requirements.requireDiagramType ? ` ${requirements.requireDiagramType}` : '';
    errors.push(`Need at least ${requirements.minMermaid}${hint} mermaid diagram(s) (found ${mermaid}).`);
  }

  const codeBlocks = countCodeBlocks(markdown);
  if (codeBlocks < requirements.minCodeBlocks) {
    errors.push(`Need at least ${requirements.minCodeBlocks} code block(s) (found ${codeBlocks}).`);
  }

  const listItems = countLists(markdown);
  if (listItems < requirements.minListItems) {
    errors.push(`Need at least ${requirements.minListItems} list item(s) (found ${listItems}).`);
  }

  if (!references || references.length === 0) {
    errors.push('references array must be non-empty — cite source files or symbols.');
  }

  return errors;
}
