// ---------------------------------------------------------------------------
// web/src/lib/contracts/wiki.ts — 前端 Wiki 领域类型镜像
// ---------------------------------------------------------------------------

export type WikiSnapshotStatus = 'ready' | 'refreshing' | 'outline_ready' | 'writing' | 'partial' | 'failed';
export type WikiDocType = 'landscape' | 'topology' | 'module' | 'flow' | 'data';
export type WikiStaleState = 'fresh' | 'possibly_stale' | 'stale' | 'semantic_review_needed' | 'conflict';
export type WikiManualState = 'none' | 'edited' | 'locked';

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

export interface WikiSnapshotTree {
  snapshot: WikiSnapshot | null;
  documents: WikiDocument[];
  draftsSummary: { ready: number; generating: number };
}

export type WikiWriteQueueItemStatus = 'queued' | 'running' | 'completed' | 'failed';
export type WikiWriteBatchStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WikiWriteQueueItem {
  id: string;
  batchId: string;
  snapshotId: string;
  projectId: string;
  documentId: string;
  documentTitle: string;
  sortOrder: number;
  status: WikiWriteQueueItemStatus;
  sessionId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WikiWriteBatch {
  id: string;
  snapshotId: string;
  projectId: string;
  workDir: string;
  locale: 'zh' | 'en';
  status: WikiWriteBatchStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface WikiWriteQueueState {
  batch: WikiWriteBatch | null;
  items: WikiWriteQueueItem[];
  runningCount: number;
  queuedCount: number;
  completedCount: number;
  failedCount: number;
  concurrency: number;
  rateLimited: boolean;
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
