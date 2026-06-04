// ---------------------------------------------------------------------------
// api/services/wiki/contracts.ts — Codebase Design Wiki 领域类型
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
  pipelineStage: 'pending' | 'drafted' | 'verified' | 'corrected' | 'done';
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
  draftIds: string[];
  affectedDocumentIds: string[];
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
  draftsSummary: { ready: number; generating: number };
}

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

// ── Block Content Validation ────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  errors?: string[];
}

function isSegmentArray(v: unknown): v is Segment[] {
  if (!Array.isArray(v)) return false;
  return v.every(
    s => s && typeof s === 'object' && 'type' in s &&
      ['text', 'bold', 'code', 'xref'].includes((s as Record<string, unknown>).type as string)
  );
}

export function validateBlockContent(blockType: WikiBlockType, content: unknown): ValidationResult {
  if (!content || typeof content !== 'object') {
    return { ok: false, errors: ['Content must be an object.'] };
  }
  const c = content as Record<string, unknown>;
  const errors: string[] = [];

  switch (blockType) {
    case 'heading': {
      if (![1, 2, 3].includes(c.level as number)) errors.push('level must be 1, 2, or 3.');
      if (typeof c.text !== 'string' || !c.text) errors.push('text is required.');
      break;
    }
    case 'prose': {
      if (!isSegmentArray(c.segments)) errors.push('segments must be a non-empty Segment[].');
      else if ((c.segments as Segment[]).length === 0) errors.push('segments must be a non-empty Segment[].');
      break;
    }
    case 'signature': {
      if (typeof c.language !== 'string') errors.push('language is required.');
      if (!Array.isArray(c.tokens) || c.tokens.length === 0) errors.push('tokens must be a non-empty array.');
      if (!c.source || typeof (c.source as Record<string, unknown>)?.file !== 'string') errors.push('source.file is required.');
      break;
    }
    case 'callout': {
      if (!['info', 'warn', 'important'].includes(c.level as string)) errors.push('level must be info, warn, or important.');
      if (!isSegmentArray(c.body)) errors.push('body must be a Segment[].');
      else if ((c.body as Segment[]).length === 0) errors.push('body must be a non-empty Segment[].');
      break;
    }
    case 'table': {
      if (!Array.isArray(c.headers) || c.headers.length === 0) errors.push('headers must be a non-empty array.');
      if (!Array.isArray(c.rows)) errors.push('rows must be an array.');
      break;
    }
    case 'diagram': {
      if (!['flowchart', 'sequence', 'er', 'state'].includes(c.diagramType as string)) errors.push('diagramType must be flowchart, sequence, er, or state.');
      if (typeof c.code !== 'string' || !c.code) errors.push('code is required.');
      break;
    }
    case 'list': {
      if (typeof c.ordered !== 'boolean') errors.push('ordered must be a boolean.');
      if (!Array.isArray(c.items) || c.items.length === 0) errors.push('items must be a non-empty array.');
      break;
    }
    default:
      errors.push(`Unknown block type: ${blockType}`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
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
  pipelineStage?: 'pending' | 'drafted' | 'verified' | 'corrected' | 'done';
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
