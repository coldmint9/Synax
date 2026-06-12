import type { WikiBlockType, WikiDocType } from './contracts.js';
import { MIN_CONTENT_LENGTH } from './tools/contracts.js';

export interface DocumentBlockInput {
  blockType: WikiBlockType;
  content: Record<string, unknown>;
}

export interface DocumentQualityOptions {
  minContentLength?: number;
}

function segmentCharCount(segments: unknown): number {
  if (!Array.isArray(segments)) return 0;
  return segments.reduce((sum, segment) => {
    if (!segment || typeof segment !== 'object') return sum;
    const value = (segment as { value?: unknown }).value;
    return sum + (typeof value === 'string' ? value.length : 0);
  }, 0);
}

export function proseCharCount(content: Record<string, unknown>): number {
  return segmentCharCount(content.segments);
}

export function calloutCharCount(content: Record<string, unknown>): number {
  return segmentCharCount(content.body);
}

export function countBlocksByType(blocks: DocumentBlockInput[]): Record<WikiBlockType, number> {
  const counts: Record<WikiBlockType, number> = {
    heading: 0,
    prose: 0,
    signature: 0,
    callout: 0,
    table: 0,
    diagram: 0,
    list: 0,
  };
  for (const block of blocks) {
    counts[block.blockType] += 1;
  }
  return counts;
}

export function countHeadingLevels(blocks: DocumentBlockInput[]): Record<1 | 2 | 3, number> {
  const counts = { 1: 0, 2: 0, 3: 0 };
  for (const block of blocks) {
    if (block.blockType !== 'heading') continue;
    const level = block.content.level;
    if (level === 1 || level === 2 || level === 3) counts[level] += 1;
  }
  return counts;
}

const STRUCTURE_REQUIREMENTS: Record<
  WikiDocType,
  {
    minProseBlocks: number;
    minCallouts: number;
    minSignatures: number;
    minTables: number;
    minDiagrams: number;
    minLists: number;
    minLevel2Headings: number;
    requireDiagramType?: string;
  }
> = {
  landscape: {
    minProseBlocks: 2,
    minCallouts: 0,
    minSignatures: 0,
    minTables: 1,
    minDiagrams: 0,
    minLists: 1,
    minLevel2Headings: 2,
  },
  topology: {
    minProseBlocks: 2,
    minCallouts: 1,
    minSignatures: 0,
    minTables: 1,
    minDiagrams: 1,
    minLists: 0,
    minLevel2Headings: 2,
    requireDiagramType: 'flowchart',
  },
  module: {
    minProseBlocks: 3,
    minCallouts: 1,
    minSignatures: 1,
    minTables: 1,
    minDiagrams: 0,
    minLists: 1,
    minLevel2Headings: 3,
  },
  flow: {
    minProseBlocks: 2,
    minCallouts: 1,
    minSignatures: 0,
    minTables: 0,
    minDiagrams: 1,
    minLists: 1,
    minLevel2Headings: 2,
    requireDiagramType: 'sequence',
  },
  data: {
    minProseBlocks: 2,
    minCallouts: 0,
    minSignatures: 0,
    minTables: 1,
    minDiagrams: 1,
    minLists: 0,
    minLevel2Headings: 2,
    requireDiagramType: 'er',
  },
};

export function validateDocumentQuality(
  docType: WikiDocType,
  blocks: DocumentBlockInput[],
  options: DocumentQualityOptions = {},
): string[] {
  const minContentLength = options.minContentLength ?? MIN_CONTENT_LENGTH;
  const errors: string[] = [];
  const counts = countBlocksByType(blocks);
  const headingLevels = countHeadingLevels(blocks);
  const requirements = STRUCTURE_REQUIREMENTS[docType];

  if (counts.prose < requirements.minProseBlocks) {
    errors.push(`Need at least ${requirements.minProseBlocks} prose blocks (found ${counts.prose}).`);
  }
  if (counts.callout < requirements.minCallouts) {
    errors.push(`Need at least ${requirements.minCallouts} callout block(s) for design decisions (found ${counts.callout}).`);
  }
  if (counts.signature < requirements.minSignatures) {
    errors.push(`Need at least ${requirements.minSignatures} signature block(s) (found ${counts.signature}).`);
  }
  if (counts.table < requirements.minTables) {
    errors.push(`Need at least ${requirements.minTables} table block(s) (found ${counts.table}).`);
  }
  if (counts.diagram < requirements.minDiagrams) {
    errors.push(`Need at least ${requirements.minDiagrams} diagram block(s) (found ${counts.diagram}).`);
  }
  if (counts.list < requirements.minLists) {
    errors.push(`Need at least ${requirements.minLists} list block(s) (found ${counts.list}).`);
  }
  if (headingLevels[2] < requirements.minLevel2Headings) {
    errors.push(`Need at least ${requirements.minLevel2Headings} level-2 heading blocks for section structure (found ${headingLevels[2]}).`);
  }

  if (requirements.requireDiagramType) {
    const hasRequiredDiagram = blocks.some(block => {
      if (block.blockType !== 'diagram') return false;
      return block.content.diagramType === requirements.requireDiagramType;
    });
    if (!hasRequiredDiagram) {
      errors.push(`Need at least one ${requirements.requireDiagramType} diagram block.`);
    }
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.blockType === 'prose') {
      const length = proseCharCount(block.content);
      if (length < minContentLength) {
        errors.push(`Block ${i + 1} (prose): ${length} chars (minimum ${minContentLength}). Expand with mechanisms, trade-offs, and concrete examples.`);
      }
    }
    if (block.blockType === 'callout') {
      const length = calloutCharCount(block.content);
      if (length < Math.max(120, Math.floor(minContentLength * 0.6))) {
        errors.push(`Block ${i + 1} (callout): ${length} chars — callouts must explain a concrete design decision, not a one-liner.`);
      }
    }
  }

  const nonHeadingBlocks = blocks.filter(b => b.blockType !== 'heading').length;
  const distinctTypes = new Set(blocks.map(b => b.blockType)).size;
  if (nonHeadingBlocks >= 6 && distinctTypes < 4) {
    errors.push(`Document mixes too few block types (${distinctTypes}). Design docs should combine prose, tables/diagrams, callouts, and signatures/lists.`);
  }

  return errors;
}
