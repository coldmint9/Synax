import type { ProviderId, CoordinatesRunEvent, AgentRunFileChange, AgentRunChangeSummary } from './agents/contracts'

export type CoordNodeType = 'project' | 'feature' | 'goal' | 'action'
// checkpoint / validator 为 v2 预留，暂未加入类型系统
export type CoordLayoutMode = 'freeform' | 'auto'
export type CoordBackgroundMode = 'plain' | 'gridLight'
export type CoordNodePositions = Record<string, { x: number; y: number }>
export type CoordNodeStatus =
  | 'pending'
  | 'draft'
  | 'active'
  | 'done'
  | 'rejection'
  | 'cancel'
  | 'review'
  | 'testing'

export interface CoordExecutor {
  type: 'agent' | 'human'
  name: string
  provider?: string
}

export type CorrectionReason = 'arch' | 'logic' | 'perf' | 'maintain'
export type ReviewRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'discarded' | 'applied'
export type ReviewOverallVerdict = 'accepted' | 'rejected' | 'blocked'
export type ActionReviewVerdict = 'accept' | 'reject' | 'blocked'

export interface NodeReviewState {
  latestRunId: string
  status: ReviewRunStatus
  verdict?: ReviewOverallVerdict | ActionReviewVerdict
  confidence?: number
  summary?: string
  updatedAt: number
}

// ── AgentRun 执行记录模型 ──
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type AgentRunVerdict = 'accepted' | 'rejected'

export interface AgentRun {
  runId: string
  provider: ProviderId | string
  status: AgentRunStatus
  startedAt: number
  completedAt?: number
  artifactSummary?: string
  events: CoordinatesRunEvent[]
  verdict?: AgentRunVerdict
  correctionNote?: string
  correctionReasons?: CorrectionReason[]
  /** 本次 run 下发给 agent 的用户输入（intent / prompt），用于在 Run Timeline 回溯 */
  prompt?: string
  /** 触发该 run 最新验收决策的 review package id */
  reviewId?: string
  /** review agent 对该 run 的判定，保留人工 verdict 的兼容字段 */
  reviewVerdict?: AgentRunVerdict
  /** 本次 run 涉及的文件级变更摘要。 */
  fileChanges?: AgentRunFileChange[]
  changeSummary?: AgentRunChangeSummary
  contextSnapshotId?: string
  inputBlockIds?: string[]
  outputBlockIds?: string[]
  eventIds?: string[]
  correctionContextBlockId?: string
}

export interface CoordNodeContextState {
  pinnedBlockIds?: string[]
  activeBundleId?: string
  unresolvedSuggestionCount?: number
  lastSnapshotId?: string
}

// ── 收敛检测 ──
export interface ConvergenceFlag {
  nodeId: string
  level: 'warn' | 'critical'
  code: 'action_bloat' | 'goal_bloat' | 'arch_coupling' | 'stale' | 'orphan' | 'thrashing' | 'circular_dep'
  message: string
}

export interface ConvergenceMetrics {
  /** @deprecated v2 — 无自动数据来源，保留兼容 */
  featureCompleteness: number
  /** @deprecated v2 — 无自动数据来源，保留兼容 */
  architectureStability: number
  divergenceRisk: number
  overallHealth: 'green' | 'yellow' | 'red'
}

export interface ConvergenceReport {
  metrics: ConvergenceMetrics
  flags: ConvergenceFlag[]
}

// ── 核心数据模型 ──
export interface CoordNode {
  id: string
  type: CoordNodeType
  label: string
  summary: string
  status: CoordNodeStatus
  progress: number
  executor?: CoordExecutor

  // === v1 旧字段（保留兼容，逐步迁移到 runs[]）===
  /** @deprecated 迁移到 runs[latest].runId */
  agentRunId?: string
  /** @deprecated 迁移到 runs[latest].events */
  agentRunLog?: string[]
  /** @deprecated 迁移到 runs[latest].artifactSummary */
  artifactSummary?: string
  /** @deprecated 迁移到 runs[latest].correctionNote */
  correctionNote?: string
  /** @deprecated 迁移到 runs[latest].correctionReasons */
  correctionReasons?: CorrectionReason[]

  // === v2 新字段 ===
  /** action 节点专属：多次执行记录 */
  runs?: AgentRun[]
  /** goal/action 最新验收状态摘要 */
  review?: NodeReviewState

  convergenceFlags?: ConvergenceFlag[]
  parentId: string | null
  children: string[]
  collapsed?: boolean
  createdAt: number
  updatedAt: number

  // === v3 新字段 ===
  /** 关联的 SourceLink.id 列表（节点 ↔ 代码锚定） */
  linkIds?: string[]
  /** 节点来源（差异渲染 / 覆盖保护）：人工 / analyzer / agent */
  origin?: 'manual' | 'analyzed' | 'agent'
  /** 语言 / 框架 / 模块类别，搜索过滤用 */
  tags?: string[]
  context?: CoordNodeContextState
}

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
  | 'system'

export type ContextBlockStatus = 'active' | 'archived' | 'superseded'

export type ContextBindingTargetKind = 'node' | 'run' | 'run_event' | 'source_link' | 'block'

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
  | 'modifies'

export interface ContextBlock {
  id: string
  projectId: string
  kind: ContextBlockKind
  title: string
  content: string
  status: ContextBlockStatus
  sourceType: string | null
  sourceId: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

export interface ContextBinding {
  id: string
  projectId: string
  blockId: string
  targetKind: ContextBindingTargetKind
  targetId: string
  relation: ContextBindingRelation
  confidence: number
  metadata: Record<string, unknown>
  createdAt: string
  createdBy: string | null
}

export interface ContextBundle {
  id: string
  projectId: string
  title: string
  blockIds: string[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

export interface FrozenContextItem {
  blockId: string
  kind: ContextBlockKind
  title: string
  content: string
  relation?: ContextBindingRelation
}

export interface ContextRunSnapshot {
  id: string
  projectId: string
  nodeId: string
  runId: string
  bundleId: string | null
  inputBlockIds: string[]
  prompt: string
  frozenContext: FrozenContextItem[]
  createdAt: string
  createdBy: string | null
}

export type AgentLoopStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export type AgentLoopStepKind =
  | 'user_input'
  | 'context_snapshot'
  | 'agent_thought'
  | 'agent_message'
  | 'tool_call'
  | 'tool_result'
  | 'artifact'
  | 'final_output'
  | 'error'

export interface AgentLoopStep {
  id: string
  loopId: string
  projectId: string
  runId: string
  sequence: number
  kind: AgentLoopStepKind
  title: string
  content: string
  payload: Record<string, unknown>
  metadata: Record<string, unknown>
  createdAt: string
}

export interface AgentLoopTranscript {
  userInput: string
  contextSnapshotId: string | null
  steps: Array<Pick<AgentLoopStep, 'sequence' | 'kind' | 'title' | 'content' | 'payload' | 'metadata'>>
}

export interface AgentLoopRecord {
  id: string
  projectId: string
  turnId: string
  nodeId: string | null
  runId: string
  provider: string
  status: AgentLoopStatus
  summary: string | null
  finalOutput: string | null
  contextSnapshotId: string | null
  transcript: AgentLoopTranscript
  fileChanges: unknown[]
  metadata: Record<string, unknown>
  startedAt: string
  completedAt: string | null
  steps?: AgentLoopStep[]
}

export type ContextSignalKind =
  | 'decision'
  | 'risk'
  | 'constraint'
  | 'evidence'
  | 'artifact'
  | 'correction'
  | 'insight'

export type ContextSignalSourceType = 'agent_loop_record' | 'review' | 'manual_note'
export type ContextDisclosureStatus = 'pending' | 'accepted' | 'dismissed' | 'auto_applied'

export interface ContextSignal {
  id: string
  projectId: string
  blockId: string
  sourceType: ContextSignalSourceType
  sourceId: string
  sourceNodeId: string | null
  sourceRunId: string | null
  kind: ContextSignalKind
  title: string
  summary: string
  content: string
  confidence: number
  tags: string[]
  sourceLinks: string[]
  metadata: Record<string, unknown>
  createdAt: string
  createdBy: string | null
}

export interface ContextDisclosureSuggestion {
  id: string
  projectId: string
  signalId: string
  sourceNodeId: string | null
  targetNodeId: string
  relation: ContextBindingRelation
  confidence: number
  reason: string
  status: ContextDisclosureStatus
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  decidedBy: string | null
  decidedAt: string | null
}

export interface SynapseNodeContext {
  nodeId: string
  incoming: Array<{
    suggestion: ContextDisclosureSuggestion
    signal: ContextSignal
    block: ContextBlock | null
  }>
  inputs: Array<{
    binding: ContextBinding
    block: ContextBlock
    signal?: ContextSignal | null
  }>
  produced: Array<{
    signal: ContextSignal
    block: ContextBlock | null
  }>
  handoffs: Array<{
    suggestion: ContextDisclosureSuggestion
    signal: ContextSignal
    targetLabel?: string | null
  }>
  latestLoop: AgentLoopRecord | null
  recentLoops: AgentLoopRecord[]
}

export interface CoordEventLogEntry {
  id: string
  projectId: string
  revision: number
  type: string
  nodeId: string | null
  runId: string | null
  contextBlockIds: string[]
  causedByEventIds: string[]
  payload: Record<string, unknown>
  actorId: string | null
  createdAt: string
}

export interface CoordinatesContextIndex {
  blocks: ContextBlock[]
  bindings: ContextBinding[]
  bundles: ContextBundle[]
  runSnapshots: ContextRunSnapshot[]
  loopRecords: AgentLoopRecord[]
  signals: ContextSignal[]
  disclosureSuggestions: ContextDisclosureSuggestion[]
  recentEvents: CoordEventLogEntry[]
  headRevision: number
}

export interface CoordEdge {
  id: string
  source: string
  target: string
  strength: number
  type: 'hierarchy' | 'dependency' | 'related'
  label?: string
  // === v3 新字段 ===
  origin?: 'manual' | 'analyzed'
  /** 回指 SemanticGraph.edges.id */
  semanticEdgeId?: string
}

export interface CoordConnectionValidation {
  ok: boolean
  reason?: string
}

// ── v3 新增：源仓库绑定 ──
export interface SourceBinding {
  kind: 'git' | 'localPath' | 'scratch'
  repoUrl?: string
  branch?: string
  /** 锁定分析时的 commit 快照 */
  commitSha?: string
  localPath?: string
  lastSyncedAt?: number
}

// ── v3 新增：代码索引（轻量元数据，完整向量体位于 analyzer 侧） ──
export interface FileEntry {
  id: string
  path: string
  language: string
  size: number
  sha: string
}

export interface SymbolEntry {
  id: string
  fileId: string
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
    | 'macro'
  name: string
  /** 如 services.acp.ProviderRegistry.register */
  qualifiedName: string
  range: { startLine: number; endLine: number }
  signature?: string
}

export interface ChunkEntry {
  id: string
  fileId: string
  symbolIds: string[]
  range: { startLine: number; endLine: number }
  /** 增量更新依据 */
  hash: string
}

export interface CodeIndex {
  /** 对应 analyzer 侧索引分片 */
  indexId: string
  files: FileEntry[]
  symbols: SymbolEntry[]
  chunks: ChunkEntry[]
  stats: { fileCount: number; symbolCount: number; chunkCount: number }
  updatedAt: number
}

// ── v3 新增：语义图（代码层 DAG） ──
export interface SemanticNode {
  id: string
  kind: 'module' | 'package' | 'boundary' | 'concept'
  label: string
  summary?: string
  evidence: { fileIds: string[]; symbolIds: string[] }
  /** 业务重要度，驱动 feature 选取 */
  score: number
}

export interface SemanticEdge {
  id: string
  source: string
  target: string
  kind: 'imports' | 'calls' | 'contains' | 'co-change'
  weight: number
}

export interface SemanticGraph {
  nodes: SemanticNode[]
  edges: SemanticEdge[]
}

// ── v3 新增：节点 ↔ 代码锚定 ──
export type SourceLinkAnchor =
  | { kind: 'file'; fileId: string }
  | { kind: 'symbol'; symbolId: string }
  | { kind: 'chunk'; chunkId: string }
  | { kind: 'concept'; semanticNodeId: string }

export interface SourceLink {
  id: string
  nodeId: string
  anchor: SourceLinkAnchor
  /** 置信度 0..1 */
  confidence: number
  createdBy: 'analyzer' | 'agent' | 'human'
}

// ── v3 新增：分析快照 / 生命周期 / 元数据 ──
export interface AnalysisReport {
  featuresCreated?: number
  goalsCreated?: number
  actionsCreated?: number
  linksCreated?: number
  message?: string
  warnings?: string[]
}

export interface AnalysisSnapshot {
  lastRunId?: string
  startedAt?: number
  completedAt?: number
  phase:
    | 'idle'
    | 'cloning'
    | 'parsing'
    | 'graph_build'
    | 'semantic'
    | 'indexing'
    | 'neo4j_write'
    | 'mapping'
    | 'ready'
    | 'failed'
  /** 0..100 */
  progress: number
  message?: string
  report?: AnalysisReport
}

export interface LifecycleState {
  initState: 'idle' | 'analyzing' | 'building' | 'ready' | 'failed'
  autoSync: boolean
  nextSyncAt?: number
}

export interface ForestMeta {
  label: string
  createdAt: number
  updatedAt: number
  language?: string
  framework?: string
  tokens: {
    analyzerToken?: string
  }
}

export interface CoordForest {
  // —— 标识与版本 ——
  projectId: string
  schemaVersion: 3
  /** 每次变更递增，SSE patch 幂等用 */
  revision: number

  // —— 坐标图 ——
  rootId: string
  nodes: Record<string, CoordNode>
  edges: CoordEdge[]

  // —— v3 新增：分析/代码/语义/链接/生命周期 ——
  source: SourceBinding
  codeIndex: CodeIndex
  semanticGraph: SemanticGraph
  links: SourceLink[]
  analysis: AnalysisSnapshot
  lifecycle: LifecycleState

  // —— 派生缓存与元数据 ——
  convergence?: ConvergenceReport
  meta: ForestMeta
}

// ── v3 新增：SSE 增量补丁 ──
export interface ForestPatch {
  projectId: string
  /** 基于哪个 revision 产生；revision <= forest.revision 时跳过 */
  baseRevision?: number
  /** 补丁自身的 revision，应用后写入 forest.revision */
  revision: number
  nodes?: { upsert?: CoordNode[]; remove?: string[] }
  edges?: { upsert?: CoordEdge[]; remove?: string[] }
  links?: { upsert?: SourceLink[]; remove?: string[] }
  codeIndex?: Partial<CodeIndex>
  semanticGraph?: Partial<SemanticGraph>
  analysis?: Partial<AnalysisSnapshot>
  lifecycle?: Partial<LifecycleState>
  meta?: Partial<ForestMeta>
}

// ── AgentRun 派生计算 ──
export function latestRun(node: CoordNode): AgentRun | undefined {
  if (!node.runs || node.runs.length === 0) return undefined
  return node.runs[node.runs.length - 1]
}

export function nodeArtifactSummary(node: CoordNode): string | undefined {
  return latestRun(node)?.artifactSummary ?? node.artifactSummary
}

export function runCount(node: CoordNode): number {
  return node.runs?.length ?? 0
}

export function rejectionCount(node: CoordNode): number {
  return node.runs?.filter(r => r.verdict === 'rejected').length ?? 0
}

// ── 连接验证 ──
const maxDependencyInbound: Partial<Record<CoordNodeType, number>> = {
  goal: 4,
  action: 1,
}

const maxDependencyOutbound: Partial<Record<CoordNodeType, number>> = {
  goal: 8,
  action: 3,
}

function canContainChild(parentType: CoordNodeType, childType: CoordNodeType) {
  if (parentType === 'project') return childType === 'feature'
  if (parentType === 'feature') return childType === 'goal'
  if (parentType === 'goal') return childType === 'action'
  return false
}

export function validateCoordConnection(
  forest: CoordForest,
  sourceId: string,
  targetId: string,
  type: CoordEdge['type'],
): CoordConnectionValidation {
  if (sourceId === targetId) return { ok: false, reason: 'Node cannot connect to itself.' }
  const source = forest.nodes[sourceId]
  const target = forest.nodes[targetId]
  if (!source || !target) return { ok: false, reason: 'Source or target node does not exist.' }
  const duplicated = forest.edges.some(
    edge => edge.source === sourceId && edge.target === targetId && edge.type === type,
  )
  if (duplicated) return { ok: false, reason: 'This connection already exists.' }

  if (type === 'hierarchy') {
    if (!canContainChild(source.type, target.type)) {
      return { ok: false, reason: `Hierarchy ${source.type} -> ${target.type} is not allowed.` }
    }
    const hierarchyInbound = forest.edges.filter(
      edge => edge.target === targetId && edge.type === 'hierarchy',
    )
    if (hierarchyInbound.length > 0) {
      return { ok: false, reason: 'Node already has a hierarchy parent.' }
    }
    if (source.type === 'goal' && source.children.length >= 12) {
      return { ok: false, reason: 'Goal node reached max action children.' }
    }
    if (source.type === 'feature' && source.children.length >= 12) {
      return { ok: false, reason: 'Feature node reached max goal children.' }
    }
    return { ok: true }
  }

  if (type === 'dependency') {
    if (source.type === 'project' || source.type === 'feature') {
      return { ok: false, reason: 'Dependency source must be goal/action.' }
    }
    if (target.type === 'project' || target.type === 'feature') {
      return { ok: false, reason: 'Dependency target must be goal/action.' }
    }
    const inbound = forest.edges.filter(edge => edge.target === targetId && edge.type === 'dependency')
    const outbound = forest.edges.filter(
      edge => edge.source === sourceId && edge.type === 'dependency',
    )
    const targetLimit = maxDependencyInbound[target.type] ?? 3
    const sourceLimit = maxDependencyOutbound[source.type] ?? 3
    if (inbound.length >= targetLimit) {
      return { ok: false, reason: `Target ${target.type} reached dependency input limit.` }
    }
    if (outbound.length >= sourceLimit) {
      return { ok: false, reason: `Source ${source.type} reached dependency output limit.` }
    }
    return { ok: true }
  }

  if (source.type === 'project' || target.type === 'project') {
    return { ok: false, reason: 'Related edges cannot attach to project node.' }
  }
  return { ok: true }
}

// ── 收敛检测 ──
function detectCircularDependency(forest: CoordForest): { nodeId: string; message: string } | null {
  const depEdges = forest.edges.filter(e => e.type === 'dependency')
  const adj = new Map<string, string[]>()
  for (const e of depEdges) {
    if (!adj.has(e.source)) adj.set(e.source, [])
    adj.get(e.source)!.push(e.target)
  }

  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()

  function dfs(nodeId: string): { nodeId: string; message: string } | null {
    color.set(nodeId, GRAY)
    const neighbors = adj.get(nodeId) ?? []
    for (const next of neighbors) {
      const c = color.get(next) ?? WHITE
      if (c === GRAY) {
        return { nodeId: next, message: `${forest.nodes[nodeId]?.label ?? nodeId} → ${forest.nodes[next]?.label ?? next}` }
      }
      if (c === WHITE) {
        const result = dfs(next)
        if (result) return result
      }
    }
    color.set(nodeId, BLACK)
    return null
  }

  for (const nodeId of Object.keys(forest.nodes)) {
    if ((color.get(nodeId) ?? WHITE) === WHITE) {
      const result = dfs(nodeId)
      if (result) return result
    }
  }
  return null
}

export function analyzeConvergence(forest: CoordForest): ConvergenceReport {
  const flags: ConvergenceFlag[] = []
  const now = Date.now()
  const threeDays = 3 * 24 * 60 * 60 * 1000

  for (const node of Object.values(forest.nodes)) {
    if (node.type === 'goal' && node.children.length > 10) {
      flags.push({ nodeId: node.id, level: 'warn', code: 'action_bloat', message: `Goal "${node.label}" has ${node.children.length} actions (recommended ≤10).` })
    }
    if (node.type === 'feature' && node.children.length > 8) {
      flags.push({ nodeId: node.id, level: 'warn', code: 'goal_bloat', message: `Feature "${node.label}" has ${node.children.length} goals (recommended ≤8).` })
    }
    if (node.status === 'rejection' && now - node.updatedAt > threeDays) {
      flags.push({ nodeId: node.id, level: 'warn', code: 'stale', message: `Action "${node.label}" has been in rejection for 3+ days.` })
    }
    if (node.parentId === null && node.id !== forest.rootId) {
      flags.push({ nodeId: node.id, level: 'warn', code: 'orphan', message: `Node "${node.label}" has no parent (orphan).` })
    }
    if (node.type === 'action' && rejectionCount(node) >= 3) {
      flags.push({ nodeId: node.id, level: 'critical', code: 'thrashing', message: `Action "${node.label}" has been rejected ${rejectionCount(node)} times consecutively.` })
    }
  }

  const cycle = detectCircularDependency(forest)
  if (cycle) {
    flags.push({ nodeId: cycle.nodeId, level: 'critical', code: 'circular_dep', message: `Circular dependency detected: ${cycle.message}.` })
  }

  const criticalCount = flags.filter(f => f.level === 'critical').length
  const warnCount = flags.filter(f => f.level === 'warn').length
  const divergenceRisk = Math.min(1.0, criticalCount * 0.3 + warnCount * 0.1)
  const overallHealth: ConvergenceMetrics['overallHealth'] = criticalCount > 0 ? 'red' : warnCount > 0 ? 'yellow' : 'green'

  return {
    metrics: { featureCompleteness: 0, architectureStability: 0, divergenceRisk, overallHealth },
    flags,
  }
}

// ── 状态常量 ──
export const AGENT_ACTION_STATUSES: CoordNodeStatus[] = ['pending', 'draft', 'active', 'done', 'rejection', 'cancel', 'review', 'testing']
export const HUMAN_ACTION_STATUSES: CoordNodeStatus[] = ['pending', 'active', 'done', 'rejection', 'cancel', 'review', 'testing']
export const FEATURE_STATUSES: CoordNodeStatus[] = ['pending', 'draft', 'active', 'review', 'testing', 'done', 'rejection', 'cancel']
export const GOAL_STATUSES: CoordNodeStatus[] = ['pending', 'draft', 'active', 'review', 'testing', 'done', 'rejection', 'cancel']

export function allowedStatusesForNode(node: CoordNode): CoordNodeStatus[] {
  if (node.type === 'feature') return FEATURE_STATUSES
  if (node.type === 'goal') return GOAL_STATUSES
  if (node.type === 'action') {
    return node.executor?.type === 'agent' ? AGENT_ACTION_STATUSES : HUMAN_ACTION_STATUSES
  }
  return ['active', 'review', 'done']
}

// ── v3 默认工厂──
export function createEmptySourceBinding(): SourceBinding {
  return { kind: 'scratch' }
}

export function createEmptyCodeIndex(): CodeIndex {
  return {
    indexId: '',
    files: [],
    symbols: [],
    chunks: [],
    stats: { fileCount: 0, symbolCount: 0, chunkCount: 0 },
    updatedAt: 0,
  }
}

export function createEmptySemanticGraph(): SemanticGraph {
  return { nodes: [], edges: [] }
}

export function createIdleAnalysis(): AnalysisSnapshot {
  return { phase: 'idle', progress: 0 }
}

export function createIdleLifecycle(): LifecycleState {
  return { initState: 'idle', autoSync: false }
}

// ── 初始森林构造 ──
export function createEmptyForest(
  projectId: string,
  projectLabel: string,
  source?: SourceBinding,
): CoordForest {
  const rootId = `project-${projectId}`
  const t = Date.now()
  return {
    projectId,
    schemaVersion: 3,
    revision: 0,
    rootId,
    nodes: {
      [rootId]: {
        id: rootId,
        type: 'project',
        label: projectLabel,
        summary: 'Project root. Add features or dispatch an intent.',
        status: 'active',
        progress: 0,
        parentId: null,
        children: [],
        origin: 'manual',
        createdAt: t,
        updatedAt: t,
      },
    },
    edges: [],
    source: source ?? createEmptySourceBinding(),
    codeIndex: createEmptyCodeIndex(),
    semanticGraph: createEmptySemanticGraph(),
    links: [],
    analysis: createIdleAnalysis(),
    lifecycle: createIdleLifecycle(),
    meta: {
      label: projectLabel,
      createdAt: t,
      updatedAt: t,
      tokens: {},
    },
  }
}

/** @deprecated Use createEmptyForest instead. Kept for backward compatibility. */
export function createInitialForest(projectId: string, projectLabel: string): CoordForest {
  return createEmptyForest(projectId, projectLabel)
}

// ── v2 → v3 迁移（localStorage 等代码路径） ──
export function migrateForestV2ToV3(old: unknown): CoordForest {
  const f = old as Partial<CoordForest> & { schemaVersion?: number }
  if (!f || typeof f !== 'object') {
    return createEmptyForest('unknown', 'Project')
  }
  if (f.schemaVersion === 3 && f.source && f.codeIndex && f.semanticGraph && f.links && f.analysis && f.lifecycle && f.meta) {
    return f as CoordForest
  }

  const projectId = f.projectId ?? 'unknown'
  const rootId = f.rootId ?? `project-${projectId}`
  const now = Date.now()
  const rootLabel =
    (f.nodes && f.nodes[rootId]?.label) || (f as { meta?: { label?: string } }).meta?.label || 'Project'

  const nodes: Record<string, CoordNode> = {}
  for (const [id, n] of Object.entries(f.nodes ?? {})) {
    nodes[id] = { ...(n as CoordNode), origin: (n as CoordNode).origin ?? 'manual' }
  }
  const edges: CoordEdge[] = (f.edges ?? []).map((e) => ({
    ...(e as CoordEdge),
    origin: (e as CoordEdge).origin ?? 'manual',
  }))

  return {
    projectId,
    schemaVersion: 3,
    revision: (f as { revision?: number }).revision ?? 0,
    rootId,
    nodes,
    edges,
    source: (f as { source?: SourceBinding }).source ?? createEmptySourceBinding(),
    codeIndex: (f as { codeIndex?: CodeIndex }).codeIndex ?? createEmptyCodeIndex(),
    semanticGraph:
      (f as { semanticGraph?: SemanticGraph }).semanticGraph ?? createEmptySemanticGraph(),
    links: (f as { links?: SourceLink[] }).links ?? [],
    analysis: (f as { analysis?: AnalysisSnapshot }).analysis ?? createIdleAnalysis(),
    lifecycle: (f as { lifecycle?: LifecycleState }).lifecycle ?? createIdleLifecycle(),
    convergence: (f as { convergence?: ConvergenceReport }).convergence,
    meta: (f as { meta?: ForestMeta }).meta ?? {
      label: rootLabel,
      createdAt: now,
      updatedAt: now,
      tokens: {},
    },
  }
}

// ── Patch 幂等合并 ──
export function applyForestPatch(forest: CoordForest, patch: ForestPatch): CoordForest {
  if (patch.projectId !== forest.projectId) return forest
  if (patch.revision <= forest.revision) return forest
  if (patch.baseRevision !== undefined && patch.baseRevision !== forest.revision) {
    // 基线不匹配：按安全策略舍弃，等待 full 快照
    return forest
  }

  // 节点
  let nodes = forest.nodes
  if (patch.nodes) {
    const next = { ...nodes }
    patch.nodes.remove?.forEach((id) => delete next[id])
    patch.nodes.upsert?.forEach((n) => {
      const prev = next[n.id]
      // origin='manual' 不被 analyzed 覆盖；仅附加分析元数据
      if (prev && prev.origin === 'manual' && n.origin === 'analyzed') {
        next[n.id] = {
          ...prev,
          linkIds: mergeUnique(prev.linkIds, n.linkIds),
          tags: mergeUnique(prev.tags, n.tags),
          updatedAt: n.updatedAt ?? prev.updatedAt,
        }
      } else {
        next[n.id] = n
      }
    })
    nodes = next
  }

  // 边
  let edges = forest.edges
  if (patch.edges) {
    const removeSet = new Set(patch.edges.remove ?? [])
    const filtered = edges.filter((e) => !removeSet.has(e.id))
    const upsertMap = new Map<string, CoordEdge>()
    patch.edges.upsert?.forEach((e) => upsertMap.set(e.id, e))
    edges = [...filtered.filter((e) => !upsertMap.has(e.id)), ...upsertMap.values()]
  }

  // 链接
  let links = forest.links
  if (patch.links) {
    const removeSet = new Set(patch.links.remove ?? [])
    const filtered = links.filter((l) => !removeSet.has(l.id))
    const upsertMap = new Map<string, SourceLink>()
    patch.links.upsert?.forEach((l) => upsertMap.set(l.id, l))
    links = [...filtered.filter((l) => !upsertMap.has(l.id)), ...upsertMap.values()]
  }

  return {
    ...forest,
    revision: patch.revision,
    nodes,
    edges,
    links,
    codeIndex: patch.codeIndex ? { ...forest.codeIndex, ...patch.codeIndex } : forest.codeIndex,
    semanticGraph: patch.semanticGraph
      ? {
          nodes: patch.semanticGraph.nodes ?? forest.semanticGraph.nodes,
          edges: patch.semanticGraph.edges ?? forest.semanticGraph.edges,
        }
      : forest.semanticGraph,
    analysis: patch.analysis ? { ...forest.analysis, ...patch.analysis } : forest.analysis,
    lifecycle: patch.lifecycle ? { ...forest.lifecycle, ...patch.lifecycle } : forest.lifecycle,
    meta: patch.meta
      ? { ...forest.meta, ...patch.meta, tokens: { ...forest.meta.tokens, ...(patch.meta.tokens ?? {}) } }
      : forest.meta,
  }
}

function mergeUnique<T>(a?: T[], b?: T[]): T[] | undefined {
  if (!a && !b) return undefined
  return Array.from(new Set([...(a ?? []), ...(b ?? [])]))
}

// ── 查询 helper ──
export function getLinksByNode(forest: CoordForest, nodeId: string): SourceLink[] {
  return forest.links.filter((l) => l.nodeId === nodeId)
}

export function getNodesBySymbol(forest: CoordForest, symbolId: string): CoordNode[] {
  const nodeIds = new Set(
    forest.links
      .filter((l) => l.anchor.kind === 'symbol' && l.anchor.symbolId === symbolId)
      .map((l) => l.nodeId),
  )
  return Array.from(nodeIds)
    .map((id) => forest.nodes[id])
    .filter((n): n is CoordNode => Boolean(n))
}
