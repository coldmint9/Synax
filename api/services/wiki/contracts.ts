// ---------------------------------------------------------------------------
// api/services/wiki/contracts.ts — Codebase Design Wiki 领域类型
// ---------------------------------------------------------------------------

export type WikiSnapshotStatus = 'ready' | 'refreshing' | 'partial' | 'failed';
export type WikiDocType =
  | 'overview'
  | 'architecture'
  | 'tech_stack'
  | 'module_design'
  | 'data_model'
  | 'api'
  | 'flow'
  | 'risk'
  | 'decision'
  | 'directory_tree'
  | 'module_spec';
export type WikiBlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'diagram'
  | 'code_ref'
  | 'decision'
  | 'risk'
  | 'task';
export type WikiBlockContentFormat = 'rich_text_json' | 'markdown_fragment' | 'diagram_json';
export type WikiStaleState = 'fresh' | 'possibly_stale' | 'stale' | 'semantic_review_needed' | 'conflict';
export type WikiManualState = 'none' | 'edited' | 'locked';
export type WikiPatchKind = 'insert' | 'update' | 'delete' | 'move' | 'split' | 'merge';
export type WikiPatchStatus = 'pending' | 'accepted' | 'dismissed' | 'conflict' | 'failed';
export type WikiPatchRisk = 'low' | 'medium' | 'high';
export type WikiRefreshTaskStatus =
  | 'queued'
  | 'indexing'
  | 'stale_checking'
  | 'semantic_reviewing'
  | 'patching'
  | 'completed'
  | 'failed';
export type WikiSourcePrecision = 'ast' | 'symbol' | 'chunk' | 'file';
export type WikiSourceType = 'coordinate' | 'ast_node' | 'symbol' | 'chunk' | 'file' | 'semantic_node' | 'dependency_edge';
export type WikiDesignMappingStatus =
  | 'draft'
  | 'planning'
  | 'ready_for_confirmation'
  | 'running'
  | 'code_changed'
  | 'wiki_previewing'
  | 'completed'
  | 'failed';

export interface WikiSnapshot {
  id: string;
  projectId: string;
  branch: string;
  headCommitSha: string;
  workingTreeHash: string;
  repoIndexId: string | null;
  revision: number;
  status: WikiSnapshotStatus;
  documentIds: string[];
  createdAt: string;
  createdBy: 'agent' | 'human' | 'system';
}

export interface WikiDocument {
  id: string;
  snapshotId: string;
  projectId: string;
  title: string;
  docType: WikiDocType;
  parentId: string | null;
  blockIds: string[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface WikiBlockGeneratedBy {
  agentRunId?: string;
  promptVersion?: string;
  model?: string;
}

export interface WikiBlock {
  id: string;
  projectId: string;
  documentId: string;
  blockType: WikiBlockType;
  content: unknown;
  contentFormat: WikiBlockContentFormat;
  sourceBindingIds: string[];
  contentHash: string;
  generatedFromHash: string | null;
  staleState: WikiStaleState;
  manualState: WikiManualState;
  confidence: number;
  generatedBy: WikiBlockGeneratedBy;
  createdAt: string;
  updatedAt: string;
}

export interface WikiBlockRevision {
  id: string;
  projectId: string;
  blockId: string;
  revision: number;
  content: unknown;
  contentHash: string;
  source: 'agent' | 'human' | 'patch';
  patchId: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface WikiSourceBinding {
  id: string;
  projectId: string;
  wikiBlockId: string;
  sourceType: WikiSourceType;
  sourceId: string;
  lastVerifiedRepoIndexId: string | null;
  lastVerifiedHash: string | null;
  precision: WikiSourcePrecision;
  confidence: number;
  createdBy: 'agent' | 'analyzer' | 'human';
  createdAt: string;
}

export interface WikiPatch {
  id: string;
  projectId: string;
  snapshotId: string;
  refreshTaskId: string | null;
  agentSessionId: string | null;
  targetDocumentId: string;
  targetBlockIds: string[];
  kind: WikiPatchKind;
  status: WikiPatchStatus;
  risk: WikiPatchRisk;
  confidence: number;
  oldContent: unknown | null;
  newContent: unknown;
  sourceDiffIds: string[];
  reasoning: string[];
  createdAt: string;
  updatedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface WikiRefreshTask {
  id: string;
  projectId: string;
  snapshotId: string;
  baseRepoIndexId: string | null;
  nextRepoIndexId: string | null;
  status: WikiRefreshTaskStatus;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  affectedBlockIds: string[];
  patchIds: string[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface WikiSnapshotTree {
  snapshot: WikiSnapshot;
  documents: WikiDocument[];
  blocks: WikiBlock[];
  sourceBindings: WikiSourceBinding[];
  patchesSummary: { pending: number; conflict: number };
}

// ── Input types ──────────────────────────────────────────────────────────────

export interface CreateWikiSnapshotInput {
  projectId: string;
  branch: string;
  headCommitSha: string;
  workingTreeHash: string;
  repoIndexId?: string;
  createdBy?: 'agent' | 'human' | 'system';
}

export interface UpsertWikiDocumentInput {
  id?: string;
  snapshotId: string;
  projectId: string;
  title: string;
  docType: WikiDocType;
  parentId?: string | null;
  blockIds?: string[];
  sortOrder?: number;
}

export interface UpsertWikiBlockInput {
  id?: string;
  projectId: string;
  documentId: string;
  blockType: WikiBlockType;
  content: unknown;
  contentFormat?: WikiBlockContentFormat;
  sourceBindingIds?: string[];
  contentHash?: string;
  generatedFromHash?: string | null;
  staleState?: WikiStaleState;
  manualState?: WikiManualState;
  confidence?: number;
  generatedBy?: WikiBlockGeneratedBy;
}

export interface UpdateBlockContentInput {
  content: unknown;
  manualState?: WikiManualState;
  actorId?: string;
}

export interface MarkdownExportResult {
  fileName: string;
  content: string;
  snapshotId: string;
  revision: number;
}
