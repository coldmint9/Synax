import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import type { WikiDocType, WikiBlockType, WikiBlockContentFormat } from '../contracts.js';

export const WIKI_DOC_TYPES: WikiDocType[] = [
  'overview', 'architecture', 'tech_stack', 'module_design',
  'data_model', 'api', 'flow',
  'directory_tree', 'module_spec',
];

export const WIKI_BLOCK_TYPES: WikiBlockType[] = [
  'heading', 'paragraph', 'list', 'table',
  'diagram', 'code_ref', 'task',
];

export const MIN_CONTENT_LENGTH = 100;
export const MIN_BLOCKS = 3;
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

export interface WikiPlannerHandle {
  tools: RegisteredTool[];
  getOutline(): WikiOutlineEntry[] | null;
}

export interface WikiWriterHandle {
  tools: RegisteredTool[];
  getCommittedDocuments(): WikiDocumentDraft[];
}
