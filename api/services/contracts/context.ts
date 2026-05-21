// ---------------------------------------------------------------------------
// api/services/contracts/context.ts
//
// 上下文管理系统的 TypeScript 领域模型。与 SQLite schema 和前端类型保持一致。
// 参考 .qoder/specs/context-management-system.md §2.2 / §3.3。
//
// 约定：
//   - 所有时间字段统一为 ISO-8601 字符串（与 DB 存储一致，避免时区歧义）
//   - metadata / tags / references 等 JSON 字段以结构化对象暴露，API 层负责
//     (序列化 ↔ 解析)，Service 层只接触领域对象
// ---------------------------------------------------------------------------

// ============================== 枚举常量 ==============================

export type SessionStatus = 'active' | 'archived' | 'expired';

export type EntryRole = 'user' | 'assistant' | 'system' | 'tool';

export type EntryContentType =
  | 'text'
  | 'code'
  | 'tool_call'
  | 'tool_result'
  | 'markdown';

export type MemoryType =
  | 'pattern'
  | 'decision'
  | 'preference'
  | 'convention'
  | 'insight'
  | 'risk';

export type MemoryStatus = 'active' | 'archived' | 'superseded';

export type LinkType =
  | 'mentions'
  | 'discusses'
  | 'creates'
  | 'modifies'
  | 'references'
  | 'resolves';

export type ContextBlockKind =
  | 'entry'
  | 'memory'
  | 'decision'
  | 'constraint'
  | 'risk'
  | 'artifact'
  | 'evidence'
  | 'bundle'
  | 'snapshot'
  | 'correction'
  | 'review'
  | 'system';

export type ContextBlockStatus = 'active' | 'archived' | 'superseded';

export type ContextBindingTargetKind =
  | 'node'
  | 'run'
  | 'run_event'
  | 'source_link'
  | 'block';

export type ContextBindingRelation =
  | 'uses'
  | 'references'
  | 'constrains'
  | 'resolves'
  | 'produces'
  | 'contains'
  | 'mentions'
  | 'discusses'
  | 'creates'
  | 'modifies';

export type CoordEventType =
  | 'coordinates_state_saved'
  | 'node_created'
  | 'node_updated'
  | 'node_deleted'
  | 'edge_created'
  | 'edge_updated'
  | 'edge_deleted'
  | 'context_block_created'
  | 'context_block_updated'
  | 'context_binding_created'
  | 'context_binding_deleted'
  | 'context_snapshot_created'
  | 'context_bundle_created'
  | 'run_created'
  | 'run_event_observed'
  | 'agent_loop_recorded'
  | 'context_signal_created'
  | 'context_disclosure_suggested'
  | 'context_disclosure_accepted'
  | 'context_disclosure_dismissed'
  | 'run_event_recorded'
  | 'run_verdict_recorded'
  | 'review_recorded'
  | 'memory_extracted';

// ============================== 领域实体 ==============================

export interface ContextSession {
  id: string;
  projectId: string;
  userId: string;
  status: SessionStatus;
  title: string | null;
  summary: string | null;
  tokenCount: number;
  entryCount: number;
  sourceAgent: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  archivedAt: string | null;
}

export interface ContextEntry {
  id: string;
  sessionId: string;
  projectId: string;
  sequence: number;
  role: EntryRole;
  content: string;
  contentType: EntryContentType;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
  parentEntryId: string | null;
  createdAt: string;
}

export interface ContextSnapshot {
  id: string;
  sessionId: string;
  projectId: string;
  label: string | null;
  fromSequence: number;
  toSequence: number;
  entryCount: number;
  compressedContent: string | null;
  diffBaseId: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface MemoryReferences {
  nodeIds?: string[];
  filePaths?: string[];
  [k: string]: unknown;
}

export interface ProjectMemory {
  id: string;
  projectId: string;
  memoryType: MemoryType;
  title: string;
  content: string;
  sourceSessionId: string | null;
  sourceEntryId: string | null;
  tags: string[];
  confidence: number;
  accessCount: number;
  references: MemoryReferences;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface ContextLink {
  id: string;
  entryId: string;
  nodeId: string;
  projectId: string;
  linkType: LinkType;
  confidence: number;
  createdAt: string;
}

export interface ContextBlock {
  id: string;
  projectId: string;
  kind: ContextBlockKind;
  title: string;
  content: string;
  status: ContextBlockStatus;
  sourceType: string | null;
  sourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface ContextBinding {
  id: string;
  projectId: string;
  blockId: string;
  targetKind: ContextBindingTargetKind;
  targetId: string;
  relation: ContextBindingRelation;
  confidence: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  createdBy: string | null;
}

export interface ContextBundle {
  id: string;
  projectId: string;
  title: string;
  blockIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface FrozenContextItem {
  blockId: string;
  kind: ContextBlockKind;
  title: string;
  content: string;
  relation?: ContextBindingRelation;
}

export interface ContextRunSnapshot {
  id: string;
  projectId: string;
  nodeId: string;
  runId: string;
  bundleId: string | null;
  inputBlockIds: string[];
  prompt: string;
  frozenContext: FrozenContextItem[];
  createdAt: string;
  createdBy: string | null;
}

export type AgentLoopStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type AgentLoopStepKind =
  | 'user_input'
  | 'context_snapshot'
  | 'agent_thought'
  | 'agent_message'
  | 'tool_call'
  | 'tool_result'
  | 'artifact'
  | 'final_output'
  | 'error';

export interface AgentLoopStep {
  id: string;
  loopId: string;
  projectId: string;
  runId: string;
  sequence: number;
  kind: AgentLoopStepKind;
  title: string;
  content: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentConversationTurn {
  id: string;
  projectId: string;
  nodeId: string | null;
  runId: string;
  userId: string | null;
  rawInput: string;
  contextSnapshotId: string | null;
  status: AgentLoopStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
}

export interface AgentLoopTranscript {
  userInput: string;
  contextSnapshotId: string | null;
  steps: Array<Pick<AgentLoopStep, 'sequence' | 'kind' | 'title' | 'content' | 'payload' | 'metadata'>>;
}

export interface AgentLoopRecord {
  id: string;
  projectId: string;
  turnId: string;
  nodeId: string | null;
  runId: string;
  provider: string;
  status: AgentLoopStatus;
  summary: string | null;
  finalOutput: string | null;
  contextSnapshotId: string | null;
  transcript: AgentLoopTranscript;
  fileChanges: unknown[];
  metadata: Record<string, unknown>;
  startedAt: string;
  completedAt: string | null;
  steps?: AgentLoopStep[];
}

export type ContextSignalKind =
  | 'decision'
  | 'risk'
  | 'constraint'
  | 'evidence'
  | 'artifact'
  | 'correction'
  | 'insight';

export type ContextSignalSourceType = 'agent_loop_record' | 'review' | 'manual_note';

export type ContextDisclosureStatus = 'pending' | 'accepted' | 'dismissed' | 'auto_applied';

export interface ContextSignal {
  id: string;
  projectId: string;
  blockId: string;
  sourceType: ContextSignalSourceType;
  sourceId: string;
  sourceNodeId: string | null;
  sourceRunId: string | null;
  kind: ContextSignalKind;
  title: string;
  summary: string;
  content: string;
  confidence: number;
  tags: string[];
  sourceLinks: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  createdBy: string | null;
}

export interface ContextDisclosureSuggestion {
  id: string;
  projectId: string;
  signalId: string;
  sourceNodeId: string | null;
  targetNodeId: string;
  relation: ContextBindingRelation;
  confidence: number;
  reason: string;
  status: ContextDisclosureStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface SynapseNodeContext {
  nodeId: string;
  incoming: Array<{
    suggestion: ContextDisclosureSuggestion;
    signal: ContextSignal;
    block: ContextBlock | null;
  }>;
  inputs: Array<{
    binding: ContextBinding;
    block: ContextBlock;
    signal?: ContextSignal | null;
  }>;
  produced: Array<{
    signal: ContextSignal;
    block: ContextBlock | null;
  }>;
  handoffs: Array<{
    suggestion: ContextDisclosureSuggestion;
    signal: ContextSignal;
    targetLabel?: string | null;
  }>;
  latestLoop: AgentLoopRecord | null;
  recentLoops: AgentLoopRecord[];
}

export interface CoordEventLogEntry {
  id: string;
  projectId: string;
  revision: number;
  type: CoordEventType | string;
  nodeId: string | null;
  runId: string | null;
  contextBlockIds: string[];
  causedByEventIds: string[];
  payload: Record<string, unknown>;
  actorId: string | null;
  createdAt: string;
}

export interface CoordinatesContextIndex {
  blocks: ContextBlock[];
  bindings: ContextBinding[];
  bundles: ContextBundle[];
  runSnapshots: ContextRunSnapshot[];
  loopRecords: AgentLoopRecord[];
  signals: ContextSignal[];
  disclosureSuggestions: ContextDisclosureSuggestion[];
  recentEvents: CoordEventLogEntry[];
  headRevision: number;
}

// ============================== 输入/过滤 ==============================

export interface CreateSessionOpts {
  title?: string;
  sourceAgent?: string;
  ttlHours?: number;
}

export interface SessionFilter {
  status?: SessionStatus;
  userId?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'updatedAt' | 'createdAt';
  order?: 'asc' | 'desc';
}

export interface NewEntry {
  role: EntryRole;
  content: string;
  contentType?: EntryContentType;
  tokenEstimate?: number;
  metadata?: Record<string, unknown>;
  parentEntryId?: string | null;
}

export interface PaginationOpts {
  offset?: number;
  limit?: number;
  /** 游标分页：返回 sequence > afterSequence 的条目 */
  afterSequence?: number;
}

export interface SnapshotOpts {
  label?: string;
  fromSequence?: number;
  toSequence?: number;
  compressedContent?: string;
  diffBaseId?: string;
  createdBy?: string;
}

export interface NewMemory {
  memoryType: MemoryType;
  title: string;
  content: string;
  sourceSessionId?: string | null;
  sourceEntryId?: string | null;
  tags?: string[];
  confidence?: number;
  references?: MemoryReferences;
  expiresAt?: string | null;
}

export interface MemoryFilter {
  memoryType?: MemoryType;
  status?: MemoryStatus;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface NewLink {
  entryId: string;
  nodeId: string;
  projectId: string;
  linkType: LinkType;
  confidence?: number;
}

export interface NewContextBlock {
  projectId: string;
  kind: ContextBlockKind;
  title: string;
  content: string;
  status?: ContextBlockStatus;
  sourceType?: string | null;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
}

export interface NewContextBinding {
  projectId: string;
  blockId: string;
  targetKind: ContextBindingTargetKind;
  targetId: string;
  relation: ContextBindingRelation;
  confidence?: number;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
}

export interface NewCoordEvent {
  projectId: string;
  type: CoordEventType | string;
  nodeId?: string | null;
  runId?: string | null;
  contextBlockIds?: string[];
  causedByEventIds?: string[];
  payload?: Record<string, unknown>;
  actorId?: string | null;
}

export interface NewAgentLoopStep {
  kind: AgentLoopStepKind;
  title: string;
  content: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface NewAgentLoopRecord {
  projectId: string;
  nodeId?: string | null;
  runId: string;
  provider: string;
  status: AgentLoopStatus;
  userId?: string | null;
  rawInput: string;
  contextSnapshotId?: string | null;
  summary?: string | null;
  finalOutput?: string | null;
  fileChanges?: unknown[];
  metadata?: Record<string, unknown>;
  steps: NewAgentLoopStep[];
  startedAt?: string;
  completedAt?: string | null;
}

export interface NewContextSignal {
  projectId: string;
  blockId: string;
  sourceType: ContextSignalSourceType;
  sourceId: string;
  sourceNodeId?: string | null;
  sourceRunId?: string | null;
  kind: ContextSignalKind;
  title: string;
  summary: string;
  content: string;
  confidence?: number;
  tags?: string[];
  sourceLinks?: string[];
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
}

export interface NewContextDisclosureSuggestion {
  projectId: string;
  signalId: string;
  sourceNodeId?: string | null;
  targetNodeId: string;
  relation: ContextBindingRelation;
  confidence?: number;
  reason: string;
  status?: ContextDisclosureStatus;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
}

// ============================== 查询/返回结构 ==============================

export interface Paginated<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface SearchFilter {
  scope?: 'entries' | 'memories' | 'all';
  role?: EntryRole;
  memoryType?: MemoryType;
  sessionId?: string;
  limit?: number;
}

export interface SearchHit {
  kind: 'entry' | 'memory';
  id: string;
  projectId: string;
  sessionId?: string;
  title?: string;
  snippet: string;
  score: number;
  createdAt: string;
}

export interface Suggestion {
  text: string;
  source: 'memory' | 'entry';
  refId: string;
  score: number;
}

export interface ContextSuggestion {
  block: ContextBlock;
  relation: ContextBindingRelation;
  score: number;
  reason: string;
}

export interface DiffResult {
  baseId: string;
  targetId: string;
  added: ContextEntry[];
  removed: ContextEntry[];
}

export interface CompressionResult {
  sessionId: string;
  summary: string;
  removedEntryCount: number;
  remainingEntryCount: number;
  snapshotId: string;
}

export interface ExportPayload {
  projectId: string;
  exportedAt: string;
  sessions: ContextSession[];
  entries: ContextEntry[];
  snapshots: ContextSnapshot[];
  memories: ProjectMemory[];
  links: ContextLink[];
}

export type ImportStrategy = 'replace' | 'merge';

export interface ImportResult {
  sessions: number;
  entries: number;
  snapshots: number;
  memories: number;
  links: number;
}

// ============================== 同步事件 ==============================

export type SyncEventType =
  | 'session_created'
  | 'session_updated'
  | 'session_archived'
  | 'session_deleted'
  | 'entry_created'
  | 'entry_updated'
  | 'entry_deleted'
  | 'snapshot_created'
  | 'memory_created'
  | 'memory_updated'
  | 'memory_deleted'
  | 'link_created'
  | 'link_deleted'
  | 'session_token_warning'
  | 'context_block_created'
  | 'context_block_updated'
  | 'context_binding_created'
  | 'context_binding_deleted'
  | 'context_snapshot_created'
  | 'context_bundle_created'
  | 'context_signal_created'
  | 'context_disclosure_suggested'
  | 'context_disclosure_updated'
  | 'coord_event_created'
  | 'coordinates_state_saved';

export interface SyncEvent<T = unknown> {
  type: SyncEventType;
  projectId: string;
  sessionId?: string;
  payload: T;
  timestamp: number;
}
