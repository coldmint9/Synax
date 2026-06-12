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

function countCallouts(markdown: string): number {
  return (markdown.match(/^>\s*\[![\w]+\]/gm) ?? []).length;
}

/** Prose lines long enough to be substantive (excludes structure, callouts, tables). */
function countSubstantiveProseLines(markdown: string, minChars = 80): number {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, '');
  return withoutFences.split('\n').filter(line => {
    const t = line.trim();
    if (t.length < minChars) return false;
    if (/^#{1,6}\s/.test(t)) return false;
    if (/^>\s/.test(t)) return false;
    if (/^(\s*[-*+]|\s*\d+\.)\s+/.test(t)) return false;
    if (t.includes('|')) return false;
    if (/^\*Source:/i.test(t)) return false;
    return true;
  }).length;
}

function hasSourceCitation(markdown: string): boolean {
  return /\*Source:\s*`[^`]+`/i.test(markdown) || /Source:\s*`[^`]+`/i.test(markdown);
}

const STRUCTURE_REQUIREMENTS: Record<
  WikiDocType,
  {
    minLevel2Headings: number;
    minTables: number;
    minMermaid: number;
    minCodeBlocks: number;
    minListItems: number;
    minCallouts: number;
    minSubstantiveProseLines: number;
    requireSourceCitation?: boolean;
    requireDiagramType?: string;
  }
> = {
  landscape: { minLevel2Headings: 2, minTables: 1, minMermaid: 0, minCodeBlocks: 0, minListItems: 1, minCallouts: 0, minSubstantiveProseLines: 4 },
  topology: { minLevel2Headings: 2, minTables: 1, minMermaid: 1, minCodeBlocks: 0, minListItems: 0, minCallouts: 1, minSubstantiveProseLines: 4, requireDiagramType: 'flowchart' },
  module: { minLevel2Headings: 3, minTables: 1, minMermaid: 0, minCodeBlocks: 1, minListItems: 1, minCallouts: 1, minSubstantiveProseLines: 8, requireSourceCitation: true },
  flow: { minLevel2Headings: 2, minTables: 0, minMermaid: 1, minCodeBlocks: 0, minListItems: 1, minCallouts: 1, minSubstantiveProseLines: 5, requireDiagramType: 'sequence' },
  data: { minLevel2Headings: 2, minTables: 1, minMermaid: 1, minCodeBlocks: 0, minListItems: 0, minCallouts: 1, minSubstantiveProseLines: 4, requireDiagramType: 'er' },
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

  const callouts = countCallouts(markdown);
  if (callouts < requirements.minCallouts) {
    errors.push(`Need at least ${requirements.minCallouts} callout(s) using > [!NOTE], > [!IMPORTANT], or > [!WARNING] (found ${callouts}).`);
  }

  const proseLines = countSubstantiveProseLines(markdown);
  if (proseLines < requirements.minSubstantiveProseLines) {
    errors.push(`Need at least ${requirements.minSubstantiveProseLines} substantive prose lines (~80+ chars, not headings/lists/tables) (found ${proseLines}). Expand ## sections with design-review depth.`);
  }

  if (requirements.requireSourceCitation && !hasSourceCitation(markdown)) {
    errors.push('Module docs must include a *Source: `path:line`* line after a primary code fence.');
  }

  if (!references || references.length === 0) {
    errors.push('references array must be non-empty — cite source files or symbols.');
  }

  return errors;
}
