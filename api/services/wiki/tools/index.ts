import { z } from 'zod';
import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import type { CodeMapScanResult } from '../../contracts/code-map.js';
import { WIKI_DOC_TYPES } from './contracts.js';
import type { WikiDocumentDraft, WikiOutlineEntry, WikiPlanEntry, WikiWriterHandle } from './contracts.js';
import { buildReadTools } from './read-tools.js';
import { buildCheckMermaidTool, buildCommitDocumentTool } from './write-tools.js';

export type { WikiDocumentDraft, WikiOutlineEntry, WikiPlanEntry, WikiPlannerHandle, WikiWriterHandle } from './contracts.js';
export { WIKI_DOC_TYPES, WIKI_BLOCK_TYPES, MIN_CONTENT_LENGTH, MIN_BLOCKS, PAGE_SIZE } from './contracts.js';
export { buildTreeString } from './helpers.js';
export { buildReadTools } from './read-tools.js';
export { buildCheckMermaidTool, buildCommitDocumentTool } from './write-tools.js';
export { createPlannerTools } from './planner-tools.js';
export { createWikiExplorerTools } from './explorer-tools.js';

export function createWriterTools(scan: CodeMapScanResult, outline: WikiOutlineEntry[]): WikiWriterHandle {
  const committedDocuments: WikiDocumentDraft[] = [];
  const readTools = buildReadTools(scan);
  const commitTool = buildCommitDocumentTool(committedDocuments, outline);
  const checkMermaid = buildCheckMermaidTool();

  return {
    tools: [...readTools, checkMermaid, commitTool],
    getCommittedDocuments: () => committedDocuments,
  };
}

export interface WikiToolsHandle {
  tools: RegisteredTool[];
  getCommittedDocuments(): WikiDocumentDraft[];
  getPlan(): WikiPlanEntry[] | null;
  getPlanIdMapping(): Map<string, string>;
}

export function createWikiTools(scan: CodeMapScanResult): WikiToolsHandle {
  const committedDocuments: WikiDocumentDraft[] = [];
  let submittedPlan: WikiPlanEntry[] | null = null;
  const planIdToDocId = new Map<string, string>();

  const readTools = buildReadTools(scan);
  const checkMermaid = buildCheckMermaidTool();
  const commitTool = buildCommitDocumentTool(committedDocuments, null);

  const submitPlanTool: RegisteredTool = {
    id: 'wiki.submit_plan',
    label: 'Submit Wiki Plan',
    description: 'Submit a hierarchical document plan. Must include: 1+ directory_tree, 1+ overview, 3+ module_spec. Total >= 8. Max depth 3.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      documents: z.array(z.object({
        id: z.string().min(1),
        docType: z.enum(WIKI_DOC_TYPES as [string, ...string[]]),
        title: z.string().min(1),
        parentId: z.string().optional(),
        targetFiles: z.array(z.string()),
        keyQuestions: z.array(z.string()).min(1),
      })).min(1),
    }),
    execute(input) {
      const args = input.args as { documents: WikiPlanEntry[] };
      if (!args?.documents || !Array.isArray(args.documents)) {
        return { result: { ok: false, error: 'documents array required.' }, displaySummary: 'Plan rejected.', artifacts: [] };
      }
      submittedPlan = args.documents;
      return {
        result: { ok: true, count: args.documents.length, message: `Plan accepted: ${args.documents.length} documents.` },
        displaySummary: `Plan accepted: ${args.documents.length} documents.`,
        artifacts: [],
      };
    },
  };

  return {
    tools: [...readTools, checkMermaid, submitPlanTool, commitTool],
    getCommittedDocuments: () => committedDocuments,
    getPlan: () => submittedPlan,
    getPlanIdMapping: () => planIdToDocId,
  };
}
