import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import type { WikiDocType, WikiReference } from '../contracts.js';

export const WIKI_DOC_TYPES: WikiDocType[] = [
  'landscape', 'topology', 'module', 'flow', 'data',
];

export const MIN_MARKDOWN_LENGTH: Record<WikiDocType, number> = {
  landscape: 1200,
  topology: 1000,
  module: 1500,
  flow: 1000,
  data: 900,
};

export const MIN_CONTENT_LENGTH = 350;
export const PAGE_SIZE = 80;

export const MIN_PACKAGE_FILES = 3;
export const COVERAGE_MIN = 0.85;
export const FILE_SPLIT = 20;
export const SYM_SPLIT = 80;

export interface WikiDocumentDraft {
  title: string;
  docType: WikiDocType;
  sortOrder?: number;
  parentPlanId?: string;
  markdown: string;
  references: WikiReference[];
  claims: WikiClaim[];
}

export type WikiOutlineNodeKind = 'section' | 'document';

export interface WikiOutlineEntry {
  id: string;
  nodeKind?: WikiOutlineNodeKind;
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
