// ---------------------------------------------------------------------------
// web/src/lib/contracts/wiki.ts — 前端 Wiki 领域类型镜像
// ---------------------------------------------------------------------------

export type WikiSnapshotStatus = 'ready' | 'refreshing' | 'outline_ready' | 'writing' | 'partial' | 'failed';
export type WikiDocType = 'landscape' | 'topology' | 'module' | 'flow' | 'data';
export type WikiBlockType = 'heading' | 'prose' | 'signature' | 'callout' | 'table' | 'diagram' | 'list';
export type WikiBlockContentFormat = 'structured_json' | 'markdown_fragment';
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

// ── Block Content Schemas ───────────────────────────────────────────────────

export type Segment =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'code'; value: string }
  | { type: 'xref'; target: string; label: string };

export interface HeadingContent {
  level: 1 | 2 | 3;
  text: string;
  anchor?: string;
}

export interface ProseContent {
  segments: Segment[];
}

export interface SignatureToken {
  type: 'keyword' | 'type' | 'name' | 'param' | 'punctuation' | 'comment';
  value: string;
}

export interface SignatureContent {
  language: string;
  tokens: SignatureToken[];
  source: { file: string; line?: number };
}

export interface CalloutContent {
  level: 'info' | 'warn' | 'important';
  title?: string;
  body: Segment[];
}

export interface TableContent {
  headers: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | { type: 'code'; value: string }>>;
}

export interface DiagramContent {
  diagramType: 'flowchart' | 'sequence' | 'er' | 'state';
  code: string;
  caption?: string;
}

export interface ListItem {
  segments: Segment[];
  children?: ListItem[];
}

export interface ListContent {
  ordered: boolean;
  items: ListItem[];
}

export type WikiBlockContent =
  | HeadingContent
  | ProseContent
  | SignatureContent
  | CalloutContent
  | TableContent
  | DiagramContent
  | ListContent;

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
