// ---------------------------------------------------------------------------
// CoordForest v3 TS 类型镜像 —— 与 web/src/lib/coordinates.ts 保持一致。
// 独立维护是因为 api 层不直接引用 web/，避免交叉 tsconfig 依赖。
// 若字段发生演进，请同步修改两侧。
// ---------------------------------------------------------------------------

export type CoordNodeType = 'project' | 'feature' | 'goal' | 'action';

import type { NodeReviewState } from './review.js';
import type { AgentRunChangeSummary, AgentRunFileChange } from '../acp/contracts.js';

export type CoordNodeStatus =
  | 'pending'
  | 'draft'
  | 'active'
  | 'done'
  | 'rejection'
  | 'cancel'
  | 'review'
  | 'testing';

export interface CoordExecutor {
  type: 'agent' | 'human';
  name: string;
  provider?: string;
}

export type CorrectionReason = 'arch' | 'logic' | 'perf' | 'maintain';

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentRunVerdict = 'accepted' | 'rejected';

export interface AgentRun {
  runId: string;
  provider: string;
  status: AgentRunStatus;
  startedAt: number;
  completedAt?: number;
  artifactSummary?: string;
  events: unknown[];
  verdict?: AgentRunVerdict;
  correctionNote?: string;
  correctionReasons?: CorrectionReason[];
  prompt?: string;
  reviewId?: string;
  reviewVerdict?: AgentRunVerdict;
  fileChanges?: AgentRunFileChange[];
  changeSummary?: AgentRunChangeSummary;
  contextSnapshotId?: string;
  inputBlockIds?: string[];
  outputBlockIds?: string[];
  eventIds?: string[];
  correctionContextBlockId?: string;
}

export interface CoordNodeContextState {
  pinnedBlockIds?: string[];
  activeBundleId?: string;
  unresolvedSuggestionCount?: number;
  lastSnapshotId?: string;
}

export interface CoordNode {
  id: string;
  type: CoordNodeType;
  label: string;
  summary: string;
  status: CoordNodeStatus;
  progress: number;
  executor?: CoordExecutor;
  parentId: string | null;
  children: string[];
  createdAt: number;
  updatedAt: number;
  // v3
  linkIds?: string[];
  origin?: 'manual' | 'analyzed' | 'agent';
  tags?: string[];
  runs?: AgentRun[];
  review?: NodeReviewState;
  context?: CoordNodeContextState;
}

export interface CoordEdge {
  id: string;
  source: string;
  target: string;
  strength: number;
  type: 'hierarchy' | 'dependency' | 'related';
  label?: string;
  origin?: 'manual' | 'analyzed';
  semanticEdgeId?: string;
}

export interface SourceBinding {
  kind: 'git' | 'localPath' | 'scratch';
  repoUrl?: string;
  branch?: string;
  commitSha?: string;
  localPath?: string;
  lastSyncedAt?: number;
}

export interface FileEntry {
  id: string;
  path: string;
  language: string;
  size: number;
  sha: string;
}

export interface SymbolEntry {
  id: string;
  fileId: string;
  kind:
    | 'function'
    | 'class'
    | 'method'
    | 'interface'
    | 'const'
    | 'type'
    | 'module'
    | 'struct'
    | 'enum'
    | 'namespace'
    | 'field'
    | 'variable'
    | 'macro';
  name: string;
  qualifiedName: string;
  range: { startLine: number; endLine: number };
  signature?: string;
}

export interface ChunkEntry {
  id: string;
  fileId: string;
  symbolIds: string[];
  range: { startLine: number; endLine: number };
  hash: string;
}

export interface CodeIndex {
  indexId: string;
  files: FileEntry[];
  symbols: SymbolEntry[];
  chunks: ChunkEntry[];
  stats: { fileCount: number; symbolCount: number; chunkCount: number };
  updatedAt: number;
}

export interface SemanticNode {
  id: string;
  kind: 'module' | 'package' | 'boundary' | 'concept';
  label: string;
  summary?: string;
  evidence: { fileIds: string[]; symbolIds: string[] };
  score: number;
}

export interface SemanticEdge {
  id: string;
  source: string;
  target: string;
  kind: 'imports' | 'calls' | 'contains' | 'co-change';
  weight: number;
}

export interface SemanticGraph {
  nodes: SemanticNode[];
  edges: SemanticEdge[];
}

export type SourceLinkAnchor =
  | { kind: 'file'; fileId: string }
  | { kind: 'symbol'; symbolId: string }
  | { kind: 'chunk'; chunkId: string }
  | { kind: 'concept'; semanticNodeId: string };

export interface SourceLink {
  id: string;
  nodeId: string;
  anchor: SourceLinkAnchor;
  confidence: number;
  createdBy: 'analyzer' | 'agent' | 'human';
}

export interface AnalysisReport {
  featuresCreated?: number;
  goalsCreated?: number;
  actionsCreated?: number;
  linksCreated?: number;
  message?: string;
  warnings?: string[];
}

export interface AnalysisSnapshot {
  lastRunId?: string;
  startedAt?: number;
  completedAt?: number;
  phase:
    | 'idle'
    | 'cloning'
    | 'parsing'
    | 'graph_build'
    | 'semantic'
    | 'indexing'
    | 'mapping'
    | 'ready'
    | 'failed';
  progress: number;
  message?: string;
  report?: AnalysisReport;
}

export interface LifecycleState {
  initState: 'idle' | 'analyzing' | 'building' | 'ready' | 'failed';
  autoSync: boolean;
  nextSyncAt?: number;
}

export interface ForestMeta {
  label: string;
  createdAt: number;
  updatedAt: number;
  language?: string;
  framework?: string;
  tokens: {
    analyzerToken?: string;
  };
}

export interface CoordForest {
  projectId: string;
  schemaVersion: 3;
  revision: number;
  rootId: string;
  nodes: Record<string, CoordNode>;
  edges: CoordEdge[];
  source: SourceBinding;
  codeIndex: CodeIndex;
  semanticGraph: SemanticGraph;
  links: SourceLink[];
  analysis: AnalysisSnapshot;
  lifecycle: LifecycleState;
  meta: ForestMeta;
}

export interface ForestPatch {
  projectId: string;
  baseRevision?: number;
  revision: number;
  nodes?: { upsert?: CoordNode[]; remove?: string[] };
  edges?: { upsert?: CoordEdge[]; remove?: string[] };
  links?: { upsert?: SourceLink[]; remove?: string[] };
  codeIndex?: Partial<CodeIndex>;
  semanticGraph?: Partial<SemanticGraph>;
  analysis?: Partial<AnalysisSnapshot>;
  lifecycle?: Partial<LifecycleState>;
  meta?: Partial<ForestMeta>;
}
