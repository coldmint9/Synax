import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import type { WikiDocType, WikiBlockType, WikiBlockContentFormat } from '../contracts.js';

export const WIKI_DOC_TYPES: WikiDocType[] = [
  'landscape', 'topology', 'module', 'flow', 'data',
];

export const WIKI_BLOCK_TYPES: WikiBlockType[] = [
  'heading', 'prose', 'signature', 'callout', 'table', 'diagram', 'list',
];

export const MIN_CONTENT_LENGTH = 350;
export const MIN_BLOCKS_BY_DOC_TYPE: Record<WikiDocType, number> = {
  landscape: 8,
  topology: 7,
  module: 10,
  flow: 8,
  data: 7,
};
export const MIN_BLOCKS = 6;
export const PAGE_SIZE = 80;

// Package baseline thresholds for outline quality gates
export const MIN_PACKAGE_FILES = 3;
export const COVERAGE_MIN = 0.85;
export const FILE_SPLIT = 20;
export const SYM_SPLIT = 80;

export interface WikiDocumentDraft {
  title: string;
  docType: WikiDocType;
  sortOrder?: number;
  parentPlanId?: string;
  blocks: Array<{
    blockType: WikiBlockType;
    content: unknown;
    contentFormat?: WikiBlockContentFormat;
    sourceHints?: string[];
    confidence?: number;
  }>;
}

export interface WikiOutlineEntry {
  id: string;
  docType: WikiDocType;
  title: string;
  parentId?: string;
  sortOrder?: number;
  targetFiles: string[];
  keyQuestions: string[];
}

export interface WikiPlanEntry {
  id: string;
  docType: WikiDocType;
  title: string;
  parentId?: string;
  targetFiles: string[];
  keyQuestions: string[];
}

export interface WikiClaim {
  id: string;
  subject: string;
  assertion: string;
  evidenceHint: string;
  centrality: 'load-bearing' | 'incidental';
}

export interface ValidationError {
  severity: 'error' | 'warning';
  field: string;
  message: string;
}

export interface OutlineDraft {
  documents: WikiOutlineEntry[];
  locked: boolean;
  validationErrors: ValidationError[];
}

export type OutlineEditOp =
  | { type: 'add'; document: WikiOutlineEntry }
  | { type: 'remove'; docId: string }
  | { type: 'update'; docId: string; changes: Partial<Pick<WikiOutlineEntry, 'targetFiles' | 'keyQuestions' | 'title' | 'parentId' | 'sortOrder'>> }
  | { type: 'replace'; docId: string; document: WikiOutlineEntry };

export interface WikiPlannerHandle {
  tools: RegisteredTool[];
  getOutline(): WikiOutlineEntry[] | null;
  getDraft(): OutlineDraft | null;
}

export interface WikiWriterHandle {
  tools: RegisteredTool[];
  getCommittedDocuments(): WikiDocumentDraft[];
}
