import { z } from 'zod';
import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import type { WikiDocType, WikiReference } from '../contracts.js';
import { validateDocumentQuality } from '../document-quality-gates.js';
import { WIKI_DOC_TYPES, MIN_MARKDOWN_LENGTH } from './contracts.js';
import type { WikiDocumentDraft, WikiOutlineEntry, WikiClaim } from './contracts.js';

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

const referenceSchema = z.object({
  filePath: z.string().min(1),
  startLine: z.number().int().optional(),
  endLine: z.number().int().optional(),
  symbol: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export function buildCommitDocumentTool(committedDocuments: WikiDocumentDraft[], outline: WikiOutlineEntry[] | null): RegisteredTool {
  return {
    id: 'wiki.commit_document',
    label: 'Commit Wiki Document',
    description: 'Submit a completed wiki document as markdown with references and verifiable claims.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      title: z.string().min(1).describe('Document title.'),
      docType: z.enum(WIKI_DOC_TYPES as [string, ...string[]]).describe('Document type.'),
      parentPlanId: z.string().optional().describe('Plan ID of the parent document from the outline. Omit for root-level.'),
      sortOrder: z.number().int().optional().describe('Display order among siblings.'),
      markdown: z.string().min(1).describe('Full document body in markdown (headings, prose, tables, mermaid fences, code blocks).'),
      references: z.array(referenceSchema).min(1).describe('Source file/symbol references cited in the document.'),
      claims: z.array(z.object({
        id: z.string().min(1),
        subject: z.string().min(1),
        assertion: z.string().min(1),
        evidenceHint: z.string().min(1),
        centrality: z.enum(['load-bearing', 'incidental']),
      })).min(1).describe('Discrete verifiable claims made in this document.'),
    }),
    execute(input) {
      const args = input.args as {
        title: string;
        docType: WikiDocType;
        parentPlanId?: string;
        sortOrder?: number;
        markdown: string;
        references: WikiReference[];
        claims: WikiClaim[];
      };

      if (!args?.markdown || !args?.title || !args?.docType) {
        return { result: { ok: false, errors: ['title, docType, and markdown are required.'], message: 'Document rejected.' }, displaySummary: 'Document rejected.', artifacts: [] };
      }

      const errors: string[] = [];
      const minLen = MIN_MARKDOWN_LENGTH[args.docType] ?? 350;
      if (args.markdown.trim().length < minLen) {
        errors.push(`Markdown too short: ${args.markdown.trim().length} chars (minimum ${minLen} for ${args.docType}).`);
      }
      errors.push(...validateDocumentQuality(args.docType, args.markdown, args.references ?? []));

      if (!args.claims || args.claims.length === 0) {
        errors.push('At least one verifiable claim is required.');
      }

      if (errors.length > 0) {
        return {
          result: { ok: false, errors, message: 'Document rejected. Fix and resubmit.' },
          displaySummary: `"${args.title}" rejected: ${errors.length} issue(s).\n${errors.map(e => '  - ' + e).join('\n')}`,
          artifacts: [],
        };
      }

      const draft: WikiDocumentDraft = {
        title: args.title,
        docType: args.docType,
        sortOrder: args.sortOrder,
        parentPlanId: args.parentPlanId,
        markdown: args.markdown,
        references: args.references,
        claims: args.claims,
      };

      committedDocuments.push(draft);
      return {
        result: { ok: true, index: committedDocuments.length - 1, title: args.title, docType: args.docType },
        displaySummary: `Committed "${args.title}" (${args.docType}). Total: ${committedDocuments.length}.`,
        artifacts: [{ kind: 'evidence', title: `Wiki: ${args.title}`, summary: `Generated ${args.docType} document.`, risk: 'low' }],
      };
    },
  };
}
