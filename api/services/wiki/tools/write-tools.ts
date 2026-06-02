import { z } from 'zod';
import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import type { WikiBlockType, WikiBlockContentFormat } from '../contracts.js';
import { WIKI_DOC_TYPES, WIKI_BLOCK_TYPES, MIN_CONTENT_LENGTH, MIN_BLOCKS } from './contracts.js';
import type { WikiDocumentDraft, WikiOutlineEntry } from './contracts.js';

export function buildCheckMermaidTool(): RegisteredTool {
  return {
    id: 'wiki.check_mermaid',
    label: 'Check Mermaid Syntax',
    description: 'Validate mermaid diagram syntax before committing. Returns parse errors so you can fix them.',
    category: 'read',
    mutability: 'read',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      code: z.string().min(1).describe('Raw mermaid diagram code (without ```mermaid fences).'),
    }),
    async execute(input) {
      const args = input.args as { code: string };
      const code = args.code.trim();
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false });
        const result = await mermaid.parse(code);
        return {
          result: { ok: true, diagramType: result?.diagramType ?? 'unknown' },
          displaySummary: `Mermaid syntax valid (${result?.diagramType ?? 'unknown'}).`,
          artifacts: [],
        };
      } catch (e: any) {
        const message = e?.message ?? String(e);
        return {
          result: { ok: false, error: message },
          displaySummary: `Mermaid syntax error:\n${message}`,
          artifacts: [],
          followUpHints: ['Fix the syntax error and re-check before committing.'],
        };
      }
    },
  };
}

export function buildCommitDocumentTool(committedDocuments: WikiDocumentDraft[], outline: WikiOutlineEntry[] | null): RegisteredTool {
  return {
    id: 'wiki.commit_document',
    label: 'Commit Wiki Document',
    description: 'Submit a completed wiki document. Pass parentPlanId to nest under a parent. Quality gates: min 3 blocks, paragraph/list/table content >= 100 chars, non-heading blocks must have sourceHints.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      title: z.string().min(1).describe('Document title.'),
      docType: z.enum(WIKI_DOC_TYPES as [string, ...string[]]).describe('Document type.'),
      parentPlanId: z.string().optional().describe('Plan ID of the parent document from the outline. Omit for root-level.'),
      sortOrder: z.number().int().optional().describe('Display order among siblings.'),
      blocks: z.array(z.object({
        blockType: z.enum(WIKI_BLOCK_TYPES as [string, ...string[]]),
        content: z.string().describe('Block content as a markdown string.'),
        contentFormat: z.enum(['rich_text_json', 'markdown_fragment', 'diagram_json']).optional(),
        sourceHints: z.array(z.string()).optional(),
        confidence: z.number().min(0).max(1).optional(),
      })).min(1).describe('Document blocks.'),
      claims: z.array(z.object({
        id: z.string().min(1).describe('Unique claim ID (e.g. "claim-runtime-node").'),
        subject: z.string().min(1).describe('What the claim is about (e.g. "runtime environment").'),
        assertion: z.string().min(1).describe('The factual assertion being made.'),
        evidenceHint: z.string().min(1).describe('Where to look to verify (file path or symbol).'),
        centrality: z.enum(['load-bearing', 'incidental']).describe('How critical this claim is.'),
      })).min(1).describe('Discrete verifiable claims made in this document.'),
    }),
    execute(input) {
      const args = input.args as WikiDocumentDraft & { parentPlanId?: string; blocks: Array<{ blockType: WikiBlockType; content: string; contentFormat?: WikiBlockContentFormat; sourceHints?: string[]; confidence?: number }> };
      if (!args?.blocks || !Array.isArray(args.blocks)) {
        return { result: { ok: false, errors: ['blocks array is required.'], message: 'Document rejected.' }, displaySummary: 'Document rejected.', artifacts: [] };
      }
      if (!args?.title || !args?.docType) {
        return { result: { ok: false, errors: ['title and docType are required.'], message: 'Document rejected.' }, displaySummary: 'Document rejected.', artifacts: [] };
      }

      const errors: string[] = [];
      if (args.parentPlanId && outline) {
        if (!outline.find(p => p.id === args.parentPlanId)) {
          errors.push(`parentPlanId "${args.parentPlanId}" not found in outline.`);
        }
      }
      if (args.blocks.length < MIN_BLOCKS) {
        errors.push(`Too few blocks: ${args.blocks.length} (minimum ${MIN_BLOCKS}).`);
      }
      for (let i = 0; i < args.blocks.length; i++) {
        const block = args.blocks[i];
        const needsContent = ['paragraph', 'list', 'table', 'code_ref'].includes(block.blockType);
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        if (needsContent && content.length < MIN_CONTENT_LENGTH) {
          errors.push(`Block ${i + 1} (${block.blockType}) too short: ${content.length} chars (min ${MIN_CONTENT_LENGTH}).`);
        }
        const needsHints = block.blockType !== 'heading' && block.blockType !== 'task';
        if (needsHints && (!block.sourceHints || block.sourceHints.length === 0)) {
          errors.push(`Block ${i + 1} (${block.blockType}) missing sourceHints.`);
        }
      }

      if (errors.length > 0) {
        return {
          result: { ok: false, errors, message: 'Document rejected. Fix and resubmit.' },
          displaySummary: `"${args.title}" rejected: ${errors.length} issue(s).\n${errors.map(e => '  - ' + e).join('\n')}`,
          artifacts: [],
        };
      }

      committedDocuments.push(args);
      return {
        result: { ok: true, index: committedDocuments.length - 1, title: args.title, docType: args.docType, blockCount: args.blocks.length },
        displaySummary: `Committed "${args.title}" (${args.docType}, ${args.blocks.length} blocks). Total: ${committedDocuments.length}.`,
        artifacts: [{ kind: 'evidence', title: `Wiki: ${args.title}`, summary: `Generated ${args.docType} with ${args.blocks.length} blocks.`, risk: 'low' }],
      };
    },
  };
}
