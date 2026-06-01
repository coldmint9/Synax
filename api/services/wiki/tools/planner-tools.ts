import { z } from 'zod';
import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import type { CodeMapScanResult } from '../../contracts/code-map.js';
import { WIKI_DOC_TYPES } from './contracts.js';
import type { WikiOutlineEntry, WikiPlannerHandle } from './contracts.js';
import { buildReadTools } from './read-tools.js';

export function createPlannerTools(scan: CodeMapScanResult): WikiPlannerHandle {
  let submittedOutline: WikiOutlineEntry[] | null = null;

  const readTools = buildReadTools(scan);

  const submitOutlineTool: RegisteredTool = {
    id: 'wiki.submit_outline',
    label: 'Submit Wiki Outline',
    description: 'Submit a hierarchical document outline. Each entry has a unique id and optional parentId for nesting. Must include: 1+ directory_tree, 1+ overview, 3+ module_spec. Total >= 8. Max depth 3. targetFiles must be real file paths from the code index.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      documents: z.array(z.object({
        id: z.string().min(1).describe('Unique local ID (e.g. "root-overview", "mod-auth").'),
        docType: z.enum(WIKI_DOC_TYPES as [string, ...string[]]).describe('Document type.'),
        title: z.string().min(1).describe('Document title.'),
        parentId: z.string().optional().describe('ID of parent document. Omit for root-level.'),
        sortOrder: z.number().int().optional().describe('Display order among siblings (default 0).'),
        targetFiles: z.array(z.string()).describe('File paths to read when writing this document.'),
        keyQuestions: z.array(z.string()).min(1).describe('Core questions this document must answer.'),
      })).min(1).describe('Planned documents with hierarchy.'),
    }),
    execute(input) {
      const args = input.args as { documents: WikiOutlineEntry[] };
      const errors: string[] = [];
      if (!args?.documents || !Array.isArray(args.documents)) {
        return { result: { ok: false, error: 'documents array is required.' }, displaySummary: 'Outline rejected.', artifacts: [] };
      }

      const idSet = new Set(args.documents.map(d => d.id));
      if (args.documents.length - idSet.size > 0) errors.push('Duplicate document IDs detected.');

      for (const doc of args.documents) {
        if (doc.parentId && !idSet.has(doc.parentId)) {
          errors.push(`"${doc.title}" references unknown parentId "${doc.parentId}".`);
        }
      }

      const depthOf = (docId: string, visited = new Set<string>()): number => {
        if (visited.has(docId)) return Infinity;
        visited.add(docId);
        const doc = args.documents.find(d => d.id === docId);
        if (!doc?.parentId) return 0;
        return 1 + depthOf(doc.parentId, visited);
      };
      for (const doc of args.documents) {
        const depth = depthOf(doc.id);
        if (depth === Infinity) errors.push(`Circular reference involving "${doc.title}".`);
        else if (depth > 4) errors.push(`"${doc.title}" exceeds max depth 4.`);
      }

      const typeCount = (t: string) => args.documents.filter(d => d.docType === t).length;
      if (typeCount('directory_tree') < 1) errors.push('Need at least 1 directory_tree.');
      if (typeCount('overview') < 1) errors.push('Need at least 1 overview.');

      if (errors.length > 0) {
        return { result: { ok: false, error: errors.join(' ') }, displaySummary: `Outline rejected:\n${errors.map(e => '  - ' + e).join('\n')}`, artifacts: [] };
      }

      submittedOutline = args.documents;
      const summary = args.documents.map(d => {
        const indent = d.parentId ? '    ' : '  ';
        return `${indent}- ${d.docType}: "${d.title}" [${d.id}]${d.parentId ? ` (child of ${d.parentId})` : ''}`;
      }).join('\n');
      return {
        result: { ok: true, count: args.documents.length, documents: args.documents },
        displaySummary: `Outline accepted: ${args.documents.length} documents.\n${summary}`,
        artifacts: [{ kind: 'decision', title: 'Wiki outline submitted', summary: `${args.documents.length} documents planned.`, risk: 'low' }],
      };
    },
  };

  return {
    tools: [...readTools, submitOutlineTool],
    getOutline: () => submittedOutline,
  };
}
