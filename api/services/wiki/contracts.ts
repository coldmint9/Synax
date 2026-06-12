// ---------------------------------------------------------------------------
// api/services/wiki/contracts.ts — Codebase Design Wiki 领域类型
// ---------------------------------------------------------------------------

export type WikiSnapshotStatus = 'ready' | 'refreshing' | 'outline_ready' | 'writing' | 'partial' | 'failed';
export type WikiDocType = 'landscape' | 'topology' | 'module' | 'flow' | 'data';
export type WikiStaleState = 'fresh' | 'possibly_stale' | 'stale' | 'semantic_review_needed' | 'conflict';
export type WikiManualState = 'none' | 'edited' | 'locked';
export type WikiRefreshTaskStatus =
  | 'queued'
  | 'indexing'
  | 'stale_checking'
  | 'semantic_reviewing'
  | 'patching'
  | 'scanning'
  | 'drafting'
  | 'completed'
  | 'failed';

export interface WikiReference {
  filePath: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  confidence?: number;
}

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
  contentMd: string;
  references: WikiReference[];
  pipelineStage: 'pending' | 'drafted' | 'verified' | 'corrected' | 'done';
  sortOrder: number;
  manualState: WikiManualState;
  staleState: WikiStaleState;
  isSection: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WikiRefreshTask {
  id: string;
  projectId: string;
  snapshotId: string;
  baseRepoIndexId: string | null;
  nextRepoIndexId: string | null;
  status: WikiRefreshTaskStatus;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  affectedDocumentIds: string[];
  draftIds: string[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface WikiSnapshotTree {
  snapshot: WikiSnapshot;
  documents: WikiDocument[];
  draftsSummary: { ready: number; generating: number };
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
  contentMd?: string;
  references?: WikiReference[];
  pipelineStage?: 'pending' | 'drafted' | 'verified' | 'corrected' | 'done';
  sortOrder?: number;
  manualState?: WikiManualState;
  staleState?: WikiStaleState;
  isSection?: boolean;
}

export interface UpdateDocumentContentInput {
  contentMd: string;
  references?: WikiReference[];
  manualState?: WikiManualState;
  actorId?: string;
}

export interface MarkdownExportResult {
  fileName: string;
  content: string;
  snapshotId: string;
  revision: number;
}

// ── Refresh Draft types ─────────────────────────────────────────────────────

export type WikiRefreshDraftStatus =
  | 'generating'
  | 'ready'
  | 'partially_applied'
  | 'applied'
  | 'discarded'
  | 'expired';

export interface DraftDocumentChange {
  documentId: string;
  oldContentMd: string | null;
  newContentMd: string | null;
  reasoning: string;
}

export interface WikiRefreshDraft {
  id: string;
  projectId: string;
  snapshotId: string;
  refreshTaskId: string | null;
  documentId: string;
  status: WikiRefreshDraftStatus;
  changes: DraftDocumentChange[];
  summary: string | null;
  sourceCommitSha: string | null;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
}

export class WikiManualProtectionError extends Error {
  constructor(public readonly documentId: string, public readonly manualState: string) {
    super(`Document ${documentId} has manualState=${manualState}; refusing to overwrite.`);
    this.name = 'WikiManualProtectionError';
  }
}
