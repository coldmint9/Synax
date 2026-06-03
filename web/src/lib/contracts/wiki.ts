// ---------------------------------------------------------------------------
// web/src/lib/contracts/wiki.ts — 前端 Wiki 领域类型镜像
// ---------------------------------------------------------------------------

export type WikiSnapshotStatus = 'ready' | 'refreshing' | 'outline_ready' | 'writing' | 'partial' | 'failed';
export type WikiDocType =
  | 'overview'
  | 'architecture'
  | 'tech_stack'
  | 'module_design'
  | 'data_model'
  | 'api'
  | 'flow'
  | 'directory_tree'
  | 'module_spec';
export type WikiBlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'diagram'
  | 'code_ref'
  | 'task';
export type WikiBlockContentFormat = 'rich_text_json' | 'markdown_fragment' | 'diagram_json';
export type WikiStaleState = 'fresh' | 'possibly_stale' | 'stale' | 'semantic_review_needed' | 'conflict';
export type WikiManualState = 'none' | 'edited' | 'locked';
export type WikiPatchKind = 'insert' | 'update' | 'delete' | 'move' | 'split' | 'merge';
export type WikiPatchStatus = 'pending' | 'accepted' | 'dismissed' | 'conflict' | 'failed';
export type WikiPatchRisk = 'low' | 'medium' | 'high';
export type WikiSourcePrecision = 'ast' | 'symbol' | 'chunk' | 'file';
export type WikiSourceType =
  | 'coordinate'
  | 'ast_node'
  | 'symbol'
  | 'chunk'
  | 'file'
  | 'semantic_node'
  | 'dependency_edge';

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
  generatedBy: { agentRunId?: string; promptVersion?: string; model?: string };
  createdAt: string;
  updatedAt: string;
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
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
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

export interface WikiSnapshotTree {
  snapshot: WikiSnapshot | null;
  documents: WikiDocument[];
  blocks: WikiBlock[];
  sourceBindings: WikiSourceBinding[];
  patchesSummary: { pending: number; conflict: number };
  draftsSummary: { ready: number; generating: number };
}

// ── Refresh Draft types ─────────────────────────────────────────────────────

export type WikiRefreshDraftStatus =
  | 'generating'
  | 'ready'
  | 'partially_applied'
  | 'applied'
  | 'discarded'
  | 'expired';

export interface DraftBlockChange {
  blockId: string;
  action: 'update' | 'delete' | 'insert_after';
  oldContent: unknown | null;
  newContent: unknown | null;
  reasoning: string;
}

export interface WikiRefreshDraft {
  id: string;
  projectId: string;
  snapshotId: string;
  refreshTaskId: string | null;
  documentId: string;
  status: WikiRefreshDraftStatus;
  changes: DraftBlockChange[];
  summary: string | null;
  sourceCommitSha: string | null;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
}
