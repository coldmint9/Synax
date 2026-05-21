import { createStore, type StoreApi, useStore } from 'zustand'
import type { Edge, Node } from '@xyflow/react'
import {
  createInitialForest,
  analyzeConvergence,
  applyForestPatch as applyForestPatchPure,
  type AgentRun,
  type CoordBackgroundMode,
  type CoordEdge,
  type CoordForest,
  type CoordNode,
  type CoordNodePositions,
  type CoordNodeType,
  type CoordinatesContextIndex,
  type CoordLayoutMode,
  type ConvergenceReport,
  type CorrectionReason,
  type ContextBindingRelation,
  type ForestPatch,
  type SourceBinding,
  validateCoordConnection,
} from '../../lib/coordinates'
import type { GoalReviewPackage } from '../../lib/api/review'
import type { CoordinatesRunEvent } from '../../lib/agents/contracts'
import type { AgentRunChangeSummary, AgentRunFileChange } from '../../lib/agents/contracts'
import { resolveProviderId } from '../../lib/agents/contracts'
import { dispatchIntent } from '../../lib/agents/dispatch-intent'
import {
  createNodeContextBinding,
  createLocalStorageCoordinatesRepository,
  fetchCoordinatesState,
  saveCoordinatesState,
  recordRunVerdict,
  type CoordinatesRepository,
} from '../../lib/api/coordinates'
import {
  fetchForestSnapshot,
  initializeFromRepoStream,
  searchCode,
  suggestMount as suggestMountApi,
  type AnalyzerStreamEvent,
  type MountHint,
  type SearchHit,
  type SearchMode,
} from '../../lib/api/analyzer'
import { computeMindMapLayout } from '../../composables/useMindMapLayout'
import { useShellStore } from './shellStore'
import { useReviewStore } from './reviewStore'

export interface CoordinatesState {
  forest: CoordForest
  nodePositions: CoordNodePositions
  selectedNodeId: string | null
  selectedEdgeId: string | null
  backgroundMode: CoordBackgroundMode
  layoutMode: CoordLayoutMode
  layoutVersion: number
  contextIndex: CoordinatesContextIndex
  lastConnectionError: string | null
  connectionMode: Extract<CoordEdge['type'], 'dependency' | 'related'>
  convergenceReport: ConvergenceReport
  /** v3: 当前代码分析任务的 abort 句柄，用于中断 init SSE */
  analysisAbort: null | (() => void)
  setSelectedNode: (nodeId: string | null) => void
  setSelectedEdge: (edgeId: string | null) => void
  setConnectionMode: (mode: Extract<CoordEdge['type'], 'dependency' | 'related'>) => void
  setBackgroundMode: (mode: CoordBackgroundMode) => void
  autoArrange: () => void
  moveNode: (nodeId: string, x: number, y: number) => void
  moveNodes: (updates: Array<{ id: string; x: number; y: number }>) => void
  createNode: (parentId: string, type: CoordNodeType) => void
  copyNode: (nodeId: string) => void
  removeNode: (nodeId: string) => void
  connectNodes: (sourceId: string, targetId: string, edgeType: CoordEdge['type']) => boolean
  removeEdge: (edgeId: string) => void
  reconnectEdge: (edgeId: string, sourceId: string, targetId: string) => boolean
  clearConnectionError: () => void
  setConnectionError: (reason: string) => void
  refreshContextIndex: () => Promise<void>
  bindContextBlockToNode: (
    nodeId: string,
    blockId: string,
    relation?: ContextBindingRelation,
  ) => Promise<void>
  submitIntent: (payload: { intent: string; featureLabel: string }) => void
  consumeRunEvents: (actionId: string, events: AsyncIterable<CoordinatesRunEvent>) => Promise<void>
  acceptRun: (actionId: string) => void
  rejectRun: (actionId: string, note: string, reasons: CorrectionReason[]) => void
  reRunAction: (actionId: string) => Promise<void>
  /** 对指定 action 节点以自定 prompt 追加一次新 run 并调度 agent。同时同步将 summary 更新为 prompt。 */
  dispatchActionPrompt: (actionId: string, prompt: string) => Promise<void>
  /** 发起 goal 验收：ReviewStore 管 SSE，CoordinatesStore 先把 goal 标记为 review。 */
  startGoalReview: (goalId: string) => Promise<void>
  /** 将用户确认过的 GoalReviewPackage 批量应用到 action/goal 状态并落盘。 */
  applyGoalReview: (pkg: GoalReviewPackage) => void
  /** 更新节点可编辑字段（label / summary） */
  updateNodeFields: (nodeId: string, fields: { label?: string; summary?: string }) => void
  recalcConvergence: () => void

  // ── v3 新增动作 ──
  /** 将 analyzer 推送的 ForestPatch 幂等合并到当前森林 */
  applyForestPatch: (patch: ForestPatch) => void
  /** 触发 analyzer pipeline（SSE），分阶段更新 forest.analysis.phase */
  initializeFromRepo: (source: SourceBinding) => Promise<void>
  /** 停止当前分析任务 */
  cancelInitialize: () => void
  /**
   * 冷启动时从后端拉取已持久化的 forest 快照（GET /forest/:projectId），
   * 覆盖当前 forest。默认仅在当前 forest 为空（revision=0）或后端
   * revision 更新时替换；传入 force=true 强制覆盖。
   * 返回是否成功替换。
   */
  hydrateFromBackend: (options?: { force?: boolean }) => Promise<boolean>
  /** 执行代码检索，mode = vector | keyword | hybrid */
  search: (query: string, mode?: SearchMode, topK?: number) => Promise<SearchHit[]>
  /** 根据 intent 追源候选挂载点 */
  suggestMount: (intent: string) => Promise<MountHint[]>
}

const stores = new Map<string, StoreApi<CoordinatesState>>()
const repository = createLocalStorageCoordinatesRepository()

function emptyContextIndex(): CoordinatesContextIndex {
  return {
    blocks: [],
    bindings: [],
    bundles: [],
    runSnapshots: [],
    loopRecords: [],
    signals: [],
    disclosureSuggestions: [],
    recentEvents: [],
    headRevision: 0,
  }
}

function now() {
  return Date.now()
}

function nextId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

function defaultLabelForType(type: CoordNodeType) {
  if (type === 'feature') return 'New feature'
  if (type === 'goal') return 'New goal'
  if (type === 'action') return 'New action'
  return 'Project'
}

function canCreateChild(parent: CoordNode | undefined, type: CoordNodeType) {
  if (!parent) return false
  if (type === 'feature') return parent.type === 'project'
  if (type === 'goal') return parent.type === 'feature'
  if (type === 'action') return parent.type === 'goal'
  return false
}

function workDirFromForest(forest: CoordForest): string | null {
  return forest.source.kind === 'localPath' && forest.source.localPath ? forest.source.localPath : null
}

function summarizeFileChanges(fileChanges: AgentRunFileChange[]): AgentRunChangeSummary {
  return fileChanges.reduce<AgentRunChangeSummary>((acc, change) => {
    acc.files += 1
    if (change.changeType === 'added') acc.added += 1
    else if (change.changeType === 'deleted') acc.deleted += 1
    else if (change.changeType === 'modified' || change.changeType === 'renamed') acc.modified += 1
    acc.insertions += change.additions ?? 0
    acc.deletions += change.deletions ?? 0
    return acc
  }, { added: 0, modified: 0, deleted: 0, files: 0, insertions: 0, deletions: 0 })
}

function mergeFileChanges(existing: AgentRunFileChange[] | undefined, incoming: AgentRunFileChange[]): AgentRunFileChange[] {
  const byPath = new Map<string, AgentRunFileChange>()
  for (const change of existing ?? []) byPath.set(change.path, change)
  for (const change of incoming) byPath.set(change.path, change)
  return [...byPath.values()]
}

function hintChangesFromEvent(event: CoordinatesRunEvent): AgentRunFileChange[] {
  const hints = event.payload?.sourceLinkHints ?? []
  const out: AgentRunFileChange[] = []
  const seen = new Set<string>()
  for (const hint of hints) {
    if (!hint.path || seen.has(hint.path)) continue
    seen.add(hint.path)
    out.push({
      path: hint.path.replace(/\\/g, '/').replace(/^\.?\//, ''),
      changeType: 'unknown',
      startLine: hint.startLine,
      endLine: hint.endLine,
      source: 'acp_hint',
    })
  }
  return out
}

function cloneRun(run: AgentRun): AgentRun {
  return {
    ...run,
    events: [...run.events],
    fileChanges: run.fileChanges ? [...run.fileChanges] : run.fileChanges,
    correctionReasons: run.correctionReasons ? [...run.correctionReasons] : run.correctionReasons,
    inputBlockIds: run.inputBlockIds ? [...run.inputBlockIds] : run.inputBlockIds,
    outputBlockIds: run.outputBlockIds ? [...run.outputBlockIds] : run.outputBlockIds,
    eventIds: run.eventIds ? [...run.eventIds] : run.eventIds,
  }
}

function mergeRuns(remoteRuns: AgentRun[] | undefined, localRuns: AgentRun[] | undefined): AgentRun[] | undefined {
  if (!remoteRuns?.length) return localRuns?.map(cloneRun)
  if (!localRuns?.length) return remoteRuns

  const remoteOrder = remoteRuns.map(run => run.runId)
  const mergedById = new Map<string, AgentRun>(remoteRuns.map(run => [run.runId, cloneRun(run)]))

  for (const localRun of localRuns) {
    const existing = mergedById.get(localRun.runId)
    if (!existing) {
      mergedById.set(localRun.runId, cloneRun(localRun))
      remoteOrder.push(localRun.runId)
      continue
    }
    mergedById.set(localRun.runId, {
      ...existing,
      status: localRun.status,
      completedAt: localRun.completedAt ?? existing.completedAt,
      artifactSummary: localRun.artifactSummary ?? existing.artifactSummary,
      verdict: localRun.verdict ?? existing.verdict,
      correctionNote: localRun.correctionNote ?? existing.correctionNote,
      correctionReasons: localRun.correctionReasons ?? existing.correctionReasons,
      prompt: localRun.prompt ?? existing.prompt,
      reviewId: localRun.reviewId ?? existing.reviewId,
      reviewVerdict: localRun.reviewVerdict ?? existing.reviewVerdict,
      fileChanges: localRun.fileChanges ?? existing.fileChanges,
      changeSummary: localRun.changeSummary ?? existing.changeSummary,
      contextSnapshotId: localRun.contextSnapshotId ?? existing.contextSnapshotId,
      inputBlockIds: localRun.inputBlockIds ?? existing.inputBlockIds,
      outputBlockIds: localRun.outputBlockIds ?? existing.outputBlockIds,
      eventIds: localRun.eventIds ?? existing.eventIds,
      correctionContextBlockId: localRun.correctionContextBlockId ?? existing.correctionContextBlockId,
      events: localRun.events.length >= existing.events.length ? [...localRun.events] : existing.events,
    })
  }

  return remoteOrder.map(runId => mergedById.get(runId)!)
}

export function mergeLocalBrowserForest(backend: CoordForest, local: CoordForest): CoordForest {
  const nodes: CoordForest['nodes'] = { ...backend.nodes }

  for (const [nodeId, localNode] of Object.entries(local.nodes)) {
    const backendNode = backend.nodes[nodeId]
    if (!backendNode) {
      nodes[nodeId] = localNode
      continue
    }
    const mergedRuns = mergeRuns(backendNode.runs, localNode.runs)
    nodes[nodeId] = mergedRuns
      ? {
          ...backendNode,
          runs: mergedRuns,
          status: localNode.runs?.length ? localNode.status : backendNode.status,
          updatedAt: Math.max(backendNode.updatedAt, localNode.updatedAt),
          review: localNode.review ?? backendNode.review,
          context: localNode.context ?? backendNode.context,
        }
      : backendNode
  }

  const seenEdgeIds = new Set(backend.edges.map(edge => edge.id))
  const edges = [...backend.edges]
  for (const edge of local.edges) {
    if (seenEdgeIds.has(edge.id)) continue
    edges.push(edge)
  }

  return {
    ...backend,
    nodes,
    edges,
  }
}

function settleInterruptedRuns(forest: CoordForest): { forest: CoordForest; changed: boolean } {
  let changed = false
  const nodes: CoordForest['nodes'] = {}

  for (const [nodeId, node] of Object.entries(forest.nodes)) {
    if (!node.runs?.length) {
      nodes[nodeId] = node
      continue
    }

    let nodeChanged = false
    const runs = node.runs.map((run) => {
      if (run.status !== 'queued' && run.status !== 'running') return run
      const ts = Date.now()
      nodeChanged = true
      changed = true
      return {
        ...run,
        status: 'cancelled' as const,
        completedAt: run.completedAt ?? ts,
        events: [
          ...(run.events ?? []),
          {
            type: 'run_failed' as const,
            ts,
            runId: run.runId,
            clusterId: nodeId,
            intent: run.prompt ?? node.summary ?? node.label,
            payload: {
              reason: 'The browser page was refreshed before this run finished, so the live agent stream was interrupted.',
              message: 'Run interrupted by page refresh.',
            },
          },
        ],
      }
    })

    nodes[nodeId] = nodeChanged
      ? { ...node, runs, status: node.status === 'active' ? 'rejection' : node.status, updatedAt: Date.now() }
      : node
  }

  return changed ? { forest: { ...forest, nodes }, changed } : { forest, changed }
}

function persist(
  projectId: string,
  state: CoordinatesState,
  repo: CoordinatesRepository,
  options: { remote?: boolean } = {},
) {
  repo.saveGraph(projectId, {
    version: 1,
    forest: state.forest,
    nodePositions: state.nodePositions,
    layoutMode: state.layoutMode,
    backgroundMode: state.backgroundMode,
  })
  if (options.remote === false) return
  void saveCoordinatesState(projectId, state.forest, 'web').catch((err) => {
    console.warn('[coordinates] saveCoordinatesState failed:', err)
  })
}

function createCoordinatesStore(projectId: string, projectLabel: string) {
  const fromStorage = repository.loadGraph(projectId)
  const settled = fromStorage ? settleInterruptedRuns(fromStorage.forest) : null
  const forest = settled?.forest ?? createInitialForest(projectId, projectLabel)
  if (fromStorage && settled?.changed) {
    repository.saveGraph(projectId, { ...fromStorage, forest })
  }
  const initialPositions = fromStorage?.nodePositions ?? (() => {
    const auto = computeMindMapLayout(forest, {})
    return Object.fromEntries(auto.nodePositions.map(p => [p.id, { x: p.x, y: p.y }]))
  })()

  const store = createStore<CoordinatesState>((set, get) => ({
    forest,
    nodePositions: initialPositions,
    selectedNodeId: forest.rootId,
    selectedEdgeId: null,
    backgroundMode: fromStorage?.backgroundMode ?? 'plain',
    layoutMode: fromStorage?.layoutMode ?? 'freeform',
    layoutVersion: 0,
    contextIndex: emptyContextIndex(),
    lastConnectionError: null,
    connectionMode: 'dependency',
    convergenceReport: analyzeConvergence(forest),
    setSelectedNode: (nodeId) => set({ selectedNodeId: nodeId, selectedEdgeId: null }),
    setSelectedEdge: (edgeId) => set({ selectedEdgeId: edgeId, selectedNodeId: null }),
    setConnectionMode: (mode) => set({ connectionMode: mode }),
    setBackgroundMode: (mode) => {
      set({ backgroundMode: mode })
      persist(projectId, get(), repository, { remote: false })
    },
    autoArrange: () => {
      const auto = computeMindMapLayout(get().forest, {})
      const next = Object.fromEntries(auto.nodePositions.map(p => [p.id, { x: p.x, y: p.y }]))
      set({ nodePositions: next, layoutMode: 'auto', layoutVersion: get().layoutVersion + 1 })
      persist(projectId, get(), repository, { remote: false })
    },
    moveNode: (nodeId, x, y) => {
      get().moveNodes([{ id: nodeId, x, y }])
    },
    moveNodes: (updates) => {
      if (updates.length === 0) return
      let changed = false
      set((state) => {
        let nextPositions = state.nodePositions
        let positionsChanged = false
        for (const update of updates) {
          if (!state.forest.nodes[update.id]) continue
          const prev = state.nodePositions[update.id]
          if (prev?.x === update.x && prev?.y === update.y) continue
          if (nextPositions === state.nodePositions) nextPositions = { ...state.nodePositions }
          nextPositions[update.id] = { x: update.x, y: update.y }
          positionsChanged = true
        }
        changed = positionsChanged || state.layoutMode !== 'freeform'
        if (!changed) return state
        return {
          nodePositions: nextPositions,
          layoutMode: 'freeform',
        }
      })
      if (changed) persist(projectId, get(), repository, { remote: false })
    },
    createNode: (parentId, type) => {
      const state = get()
      const parent = state.forest.nodes[parentId]
      if (!canCreateChild(parent, type)) return
      const id = nextId(type)
      const created: CoordNode = {
        id,
        type,
        label: defaultLabelForType(type),
        summary: 'Add a short description in the Summary field below.',
        status: 'pending',
        progress: 0,
        parentId,
        children: [],
        createdAt: now(),
        updatedAt: now(),
      }
      const nodes = { ...state.forest.nodes, [id]: created }
      const parentNode = { ...parent, children: [...parent.children, id], updatedAt: now() }
      nodes[parentId] = parentNode
      const edges = [...state.forest.edges, {
        id: nextId('edge'),
        source: parentId,
        target: id,
        type: 'hierarchy',
        strength: 0.8,
      } satisfies CoordEdge]
      const parentPos = state.nodePositions[parentId] ?? { x: 80, y: 80 }
      const newForest = { ...state.forest, nodes, edges }
      set({
        forest: newForest,
        nodePositions: {
          ...state.nodePositions,
          [id]: { x: parentPos.x + 340, y: parentPos.y + (parent.children.length + 1) * 110 },
        },
        selectedNodeId: id,
        convergenceReport: analyzeConvergence(newForest),
      })
      persist(projectId, get(), repository)
    },
    copyNode: (nodeId) => {
      const state = get()
      const node = state.forest.nodes[nodeId]
      if (!node || !node.parentId) return
      if (!canCreateChild(state.forest.nodes[node.parentId], node.type)) return
      const id = nextId(node.type)
      const copy: CoordNode = {
        ...node,
        id,
        label: `${node.label} Copy`,
        children: [],
        createdAt: now(),
        updatedAt: now(),
      }
      const parent = state.forest.nodes[node.parentId]
      const nodes = { ...state.forest.nodes, [id]: copy, [parent.id]: { ...parent, children: [...parent.children, id] } }
      const edges = [...state.forest.edges, {
        id: nextId('edge'),
        source: parent.id,
        target: id,
        type: 'hierarchy',
        strength: 0.8,
      } satisfies CoordEdge]
      const p = state.nodePositions[nodeId] ?? { x: 100, y: 100 }
      const newForest = { ...state.forest, nodes, edges }
      set({
        forest: newForest,
        nodePositions: { ...state.nodePositions, [id]: { x: p.x + 36, y: p.y + 36 } },
        selectedNodeId: id,
        convergenceReport: analyzeConvergence(newForest),
      })
      persist(projectId, get(), repository)
    },
    removeNode: (nodeId) => {
      const state = get()
      const node = state.forest.nodes[nodeId]
      if (!node || node.parentId === null) return
      const ids = new Set<string>()
      const walk = (id: string) => {
        ids.add(id)
        const n = state.forest.nodes[id]
        if (!n) return
        n.children.forEach(walk)
      }
      walk(nodeId)
      const nodes = { ...state.forest.nodes }
      ids.forEach(id => delete nodes[id])
      const parent = state.forest.nodes[node.parentId]
      if (parent && nodes[parent.id]) {
        nodes[parent.id] = { ...parent, children: parent.children.filter(id => id !== nodeId) }
      }
      const edges = state.forest.edges.filter(edge => !ids.has(edge.source) && !ids.has(edge.target))
      const nextPositions = { ...state.nodePositions }
      ids.forEach(id => delete nextPositions[id])
      const newForest = { ...state.forest, nodes, edges }
      set({
        forest: newForest,
        nodePositions: nextPositions,
        selectedNodeId: parent?.id ?? state.forest.rootId,
        convergenceReport: analyzeConvergence(newForest),
      })
      persist(projectId, get(), repository)
    },
    connectNodes: (sourceId, targetId, edgeType) => {
      const state = get()
      const check = validateCoordConnection(state.forest, sourceId, targetId, edgeType)
      if (!check.ok) {
        set({ lastConnectionError: check.reason ?? 'Invalid connection' })
        return false
      }
      const edge: CoordEdge = {
        id: nextId('edge'),
        source: sourceId,
        target: targetId,
        type: edgeType,
        strength: edgeType === 'dependency' ? 0.65 : 0.5,
      }
      const newForest = { ...state.forest, edges: [...state.forest.edges, edge] }
      set({
        forest: newForest,
        selectedEdgeId: edge.id,
        selectedNodeId: null,
        lastConnectionError: null,
        convergenceReport: analyzeConvergence(newForest),
      })
      persist(projectId, get(), repository)
      return true
    },
    removeEdge: (edgeId) => {
      const state = get()
      const edge = state.forest.edges.find(e => e.id === edgeId)
      if (!edge) return
      if (edge.type === 'hierarchy') {
        set({ lastConnectionError: 'Hierarchy edges are structural and cannot be removed.' })
        return
      }
      const newForest = { ...state.forest, edges: state.forest.edges.filter(e => e.id !== edgeId) }
      set({
        forest: newForest,
        selectedEdgeId: null,
        lastConnectionError: null,
        convergenceReport: analyzeConvergence(newForest),
      })
      persist(projectId, get(), repository)
    },
    reconnectEdge: (edgeId, sourceId, targetId) => {
      const state = get()
      const current = state.forest.edges.find(e => e.id === edgeId)
      if (!current || current.type === 'hierarchy') {
        set({ lastConnectionError: 'Only dependency/related edges can be reconnected.' })
        return false
      }
      const edgesWithout = state.forest.edges.filter(e => e.id !== edgeId)
      const check = validateCoordConnection({ ...state.forest, edges: edgesWithout }, sourceId, targetId, current.type)
      if (!check.ok) {
        set({ lastConnectionError: check.reason ?? 'Reconnect is invalid.' })
        return false
      }
      const nextEdge: CoordEdge = { ...current, source: sourceId, target: targetId }
      const newForest = { ...state.forest, edges: [...edgesWithout, nextEdge] }
      set({
        forest: newForest,
        selectedEdgeId: edgeId,
        selectedNodeId: null,
        lastConnectionError: null,
        convergenceReport: analyzeConvergence(newForest),
      })
      persist(projectId, get(), repository)
      return true
    },
    clearConnectionError: () => set({ lastConnectionError: null }),
    setConnectionError: (reason) => set({ lastConnectionError: reason }),

    refreshContextIndex: async () => {
      try {
        const state = await fetchCoordinatesState(projectId)
        set({ contextIndex: state.context ?? emptyContextIndex() })
      } catch (err) {
        console.warn('[coordinates] refreshContextIndex failed:', err)
      }
    },

    bindContextBlockToNode: async (nodeId, blockId, relation = 'references') => {
      try {
        const binding = await createNodeContextBinding({
          projectId,
          nodeId,
          blockId,
          relation,
          createdBy: 'web',
        })
        set(s => ({
          contextIndex: {
            ...s.contextIndex,
            bindings: [
              binding,
              ...s.contextIndex.bindings.filter(b => b.id !== binding.id),
            ],
          },
        }))
      } catch (err) {
        console.warn('[coordinates] bindContextBlockToNode failed:', err)
        set({ lastConnectionError: (err as Error).message })
      }
      void get().refreshContextIndex()
    },

    recalcConvergence: () => {
      set(state => ({ convergenceReport: analyzeConvergence(state.forest) }))
    },

    submitIntent: ({ intent, featureLabel }) => {
      const state = get()
      const selId = state.selectedNodeId
      const selNode = selId ? state.forest.nodes[selId] : null

      // 选定 action → 对该 action 以新 prompt 触发新 run
      if (selNode?.type === 'action') {
        void get().dispatchActionPrompt(selNode.id, intent)
        return
      }

      // 选定 goal → 在该 goal 下新建 action 并调度
      if (selNode?.type === 'goal') {
        const goal = selNode
        const actionId = nextId('action')
        const newAction: CoordNode = {
          id: actionId,
          type: 'action',
          label: intent.slice(0, 72) || 'Agent Action',
          summary: intent || 'No intent body.',
          status: 'pending',
          progress: 0,
          executor: { type: 'agent', name: 'OpenCode Agent', provider: 'opencode-acp' },
          parentId: goal.id,
          children: [],
          runs: [],
          createdAt: now(),
          updatedAt: now(),
        }
        const goalPos = state.nodePositions[goal.id] ?? { x: 420, y: 200 }
        const newNodes = {
          ...state.forest.nodes,
          [actionId]: newAction,
          [goal.id]: { ...goal, children: [...goal.children, actionId], updatedAt: now() },
        }
        const newEdges = [...state.forest.edges, {
          id: nextId('edge'), source: goal.id, target: actionId, type: 'hierarchy', strength: 0.8,
        } as CoordEdge]
        const newF = { ...state.forest, nodes: newNodes, edges: newEdges }
        set({
          forest: newF,
          nodePositions: {
            ...state.nodePositions,
            [actionId]: { x: goalPos.x + 340, y: goalPos.y + (goal.children.length + 1) * 120 },
          },
          selectedNodeId: actionId,
          selectedEdgeId: null,
          convergenceReport: analyzeConvergence(newF),
        })
        persist(projectId, get(), repository)
        void get().dispatchActionPrompt(actionId, intent)
        return
      }

      // 选定 feature → 沿用其 label；否则使用 toolbar 传入的 featureLabel
      const label = selNode?.type === 'feature' ? selNode.label : (featureLabel.trim() || 'General')
      let feature = Object.values(state.forest.nodes).find(n => n.type === 'feature' && n.label === label)
      if (!feature) {
        const id = nextId('feature')
        feature = {
          id,
          type: 'feature',
          label,
          summary: 'Auto-created from toolbar intent submission.',
          status: 'active',
          progress: 15,
          parentId: state.forest.rootId,
          children: [],
          createdAt: now(),
          updatedAt: now(),
        }
        const root = state.forest.nodes[state.forest.rootId]
        const nodes = {
          ...state.forest.nodes,
          [id]: feature,
          [root.id]: { ...root, children: [...root.children, id], updatedAt: now() },
        }
        const edges = [...state.forest.edges, {
          id: nextId('edge'),
          source: root.id,
          target: id,
          type: 'hierarchy',
          strength: 0.8,
        } satisfies CoordEdge]
        set({
          forest: { ...state.forest, nodes, edges },
          nodePositions: {
            ...state.nodePositions,
            [id]: { x: (state.nodePositions[root.id]?.x ?? 80) + 340, y: (state.nodePositions[root.id]?.y ?? 80) + 120 },
          },
        })
      }
      const latest = get()
      const parent = Object.values(latest.forest.nodes).find(n => n.type === 'feature' && n.label === label)!
      const goalId = nextId('goal')
      const actionId = nextId('action')

      const runId = nextId('run')
      const run: AgentRun = {
        runId,
        provider: 'opencode-acp',
        status: 'queued',
        startedAt: now(),
        events: [],
        prompt: intent,
      }

      const goal: CoordNode = {
        id: goalId,
        type: 'goal',
        label: 'Intent Goal',
        summary: `Goal extracted from intent: ${intent.slice(0, 120)}`,
        status: 'active',
        progress: 20,
        parentId: parent.id,
        children: [actionId],
        createdAt: now(),
        updatedAt: now(),
      }
      const action: CoordNode = {
        id: actionId,
        type: 'action',
        label: intent.slice(0, 72) || 'Agent Action',
        summary: intent || 'No intent body.',
        status: 'active',
        progress: 5,
        executor: { type: 'agent', name: 'OpenCode Agent', provider: 'opencode-acp' },
        parentId: goalId,
        children: [],
        runs: [run],
        createdAt: now(),
        updatedAt: now(),
      }
      const parentNode = latest.forest.nodes[parent.id]
      const nodes = {
        ...latest.forest.nodes,
        [goalId]: goal,
        [actionId]: action,
        [parent.id]: { ...parentNode, children: [...parentNode.children, goalId], updatedAt: now() },
      }
      const edges = [
        ...latest.forest.edges,
        { id: nextId('edge'), source: parent.id, target: goalId, type: 'hierarchy', strength: 0.8 } as CoordEdge,
        { id: nextId('edge'), source: goalId, target: actionId, type: 'hierarchy', strength: 0.8 } as CoordEdge,
      ]
      const parentPos = latest.nodePositions[parent.id] ?? { x: 420, y: 200 }
      const newForest = { ...latest.forest, nodes, edges }
      set({
        forest: newForest,
        nodePositions: {
          ...latest.nodePositions,
          [goalId]: { x: parentPos.x + 340, y: parentPos.y + (parentNode.children.length + 1) * 120 },
          [actionId]: { x: parentPos.x + 680, y: parentPos.y + (parentNode.children.length + 1) * 120 + 20 },
        },
        selectedNodeId: actionId,
        selectedEdgeId: null,
        convergenceReport: analyzeConvergence(newForest),
      })
      persist(projectId, get(), repository)

      // 异步调度 agent
      setTimeout(async () => {
        try {
          const store = get()
          const actionNode = store.forest.nodes[actionId]
          if (!actionNode?.runs?.length) return

          const result = await dispatchIntent({
            projectId,
            userId: 'default',
            userName: 'default',
            intent,
            providerId: 'opencode-acp',
            context: { selectedNodeId: actionId, workDir: workDirFromForest(store.forest) },
          })
          await store.consumeRunEvents(actionId, result.events)
        } catch (err) {
          console.error('Intent dispatch failed:', err)
          set(s => {
            const a = s.forest.nodes[actionId]
            if (!a?.runs?.length) return s
            const runs = [...a.runs]
            runs[runs.length - 1] = { ...runs[runs.length - 1], status: 'failed', completedAt: now() }
            const newForest = { ...s.forest, nodes: { ...s.forest.nodes, [actionId]: { ...a, runs, status: 'rejection' as CoordNode['status'] } } }
            persist(projectId, { ...get(), forest: newForest }, repository)
            return { forest: newForest, convergenceReport: analyzeConvergence(newForest) }
          })
        }
      }, 100)
    },

    consumeRunEvents: async (actionId: string, events: AsyncIterable<CoordinatesRunEvent>) => {
      const state = get()
      const action = state.forest.nodes[actionId]
      if (!action?.runs?.length) return
      const runIndex = action.runs.length - 1

      for await (const event of events) {
        set(s => {
          const a = s.forest.nodes[actionId]
          if (!a?.runs?.length) return s
          const runs = [...a.runs]
          const currentRun = { ...runs[runIndex] }
          currentRun.events = [...currentRun.events, event]

          switch (event.type) {
            case 'run_started':
              currentRun.status = 'running'
              if (typeof event.payload?.contextSnapshotId === 'string') {
                currentRun.contextSnapshotId = event.payload.contextSnapshotId
              }
              break
            case 'agent_message':
              // 保持 running 状态
              break
            case 'artifact_proposed':
              if (event.payload?.message) {
                currentRun.artifactSummary = event.payload.message
              }
              if (Array.isArray((event.payload as any)?.contextBlockIds)) {
                currentRun.outputBlockIds = Array.from(new Set([...(currentRun.outputBlockIds ?? []), ...((event.payload as any).contextBlockIds as string[])]))
              }
              if (event.payload?.sourceLinkHints?.length) {
                const merged = mergeFileChanges(currentRun.fileChanges, hintChangesFromEvent(event))
                currentRun.fileChanges = merged
                currentRun.changeSummary = summarizeFileChanges(merged)
              }
              break
            case 'artifact_applied':
              if (event.payload?.message) {
                currentRun.artifactSummary = event.payload.message
              }
              if (Array.isArray((event.payload as any)?.contextBlockIds)) {
                currentRun.outputBlockIds = Array.from(new Set([...(currentRun.outputBlockIds ?? []), ...((event.payload as any).contextBlockIds as string[])]))
              }
              if (event.payload?.sourceLinkHints?.length) {
                const merged = mergeFileChanges(currentRun.fileChanges, hintChangesFromEvent(event))
                currentRun.fileChanges = merged
                currentRun.changeSummary = summarizeFileChanges(merged)
              }
              break
            case 'run_completed':
              currentRun.status = 'completed'
              currentRun.completedAt = event.ts
              if (Array.isArray((event.payload as any)?.contextBlockIds)) {
                currentRun.outputBlockIds = Array.from(new Set([...(currentRun.outputBlockIds ?? []), ...((event.payload as any).contextBlockIds as string[])]))
              }
              if (event.payload?.fileChanges) {
                currentRun.fileChanges = event.payload.fileChanges
                currentRun.changeSummary = event.payload.changeSummary ?? summarizeFileChanges(event.payload.fileChanges)
              }
              break
            case 'run_failed':
              currentRun.status = 'failed'
              currentRun.completedAt = event.ts
              break
            case 'run_blocked':
              // 标记阻塞但不改变 status
              break
          }

          runs[runIndex] = currentRun

          let newNodeStatus = a.status
          if (currentRun.status === 'completed') newNodeStatus = 'done'
          else if (currentRun.status === 'failed') newNodeStatus = 'rejection'
          else if (currentRun.status === 'running') newNodeStatus = 'active'

          const updatedNode = { ...a, runs, status: newNodeStatus as CoordNode['status'] }
          const newForest = { ...s.forest, nodes: { ...s.forest.nodes, [actionId]: updatedNode } }
          persist(projectId, { ...get(), forest: newForest }, repository)
          return {
            forest: newForest,
            convergenceReport: analyzeConvergence(newForest),
          }
        })
      }
    },

    acceptRun: (actionId: string) => {
      let latestRunId: string | undefined
      set(s => {
        const a = s.forest.nodes[actionId]
        if (!a?.runs?.length) return s
        const runs = [...a.runs]
        latestRunId = runs[runs.length - 1]?.runId
        runs[runs.length - 1] = { ...runs[runs.length - 1], verdict: 'accepted' }
        const updatedNode = { ...a, runs, status: 'done' as CoordNode['status'] }
        const newForest = { ...s.forest, nodes: { ...s.forest.nodes, [actionId]: updatedNode } }
        persist(projectId, { ...get(), forest: newForest }, repository)
        return {
          forest: newForest,
          convergenceReport: analyzeConvergence(newForest),
        }
      })
      if (latestRunId) {
        void recordRunVerdict({
          projectId,
          nodeId: actionId,
          runId: latestRunId,
          verdict: 'accepted',
          actorId: 'web',
        }).catch((err) => console.warn('[coordinates] record accepted verdict failed:', err))
      }
    },

    rejectRun: (actionId: string, note: string, reasons: CorrectionReason[]) => {
      let latestRunId: string | undefined
      set(s => {
        const a = s.forest.nodes[actionId]
        if (!a?.runs?.length) return s
        const runs = [...a.runs]
        latestRunId = runs[runs.length - 1]?.runId
        runs[runs.length - 1] = {
          ...runs[runs.length - 1],
          verdict: 'rejected',
          correctionNote: note,
          correctionReasons: reasons,
        }
        const updatedNode = { ...a, runs, status: 'rejection' as CoordNode['status'] }
        const newForest = { ...s.forest, nodes: { ...s.forest.nodes, [actionId]: updatedNode } }
        persist(projectId, { ...get(), forest: newForest }, repository)
        return {
          forest: newForest,
          convergenceReport: analyzeConvergence(newForest),
        }
      })
      if (latestRunId) {
        void recordRunVerdict({
          projectId,
          nodeId: actionId,
          runId: latestRunId,
          verdict: 'rejected',
          note,
          reasons,
          actorId: 'web',
        }).catch((err) => console.warn('[coordinates] record rejected verdict failed:', err))
      }
    },

    reRunAction: async (actionId: string) => {
      const state = get()
      const action = state.forest.nodes[actionId]
      if (!action) return

      const newRun: AgentRun = {
        runId: nextId('run'),
        provider: resolveProviderId(action.executor?.provider) as AgentRun['provider'],
        status: 'queued',
        startedAt: now(),
        events: [],
        prompt: action.summary || action.label,
      }

      set(s => {
        const a = s.forest.nodes[actionId]
        const runs = [...(a?.runs ?? []), newRun]
        const updatedNode = { ...a, runs, status: 'active' as CoordNode['status'] }
        const newForest = { ...s.forest, nodes: { ...s.forest.nodes, [actionId]: updatedNode } }
        persist(projectId, { ...get(), forest: newForest }, repository)
        return {
          forest: newForest,
          convergenceReport: analyzeConvergence(newForest),
        }
      })

      try {
        const result = await dispatchIntent({
          projectId,
          userId: 'default',
          userName: 'default',
          intent: action.label,
          providerId: resolveProviderId(action.executor?.provider),
          context: { selectedNodeId: actionId, workDir: workDirFromForest(get().forest) },
        })
        await get().consumeRunEvents(actionId, result.events)
      } catch (err) {
        console.error('Re-run dispatch failed:', err)
        set(s => {
          const a = s.forest.nodes[actionId]
          if (!a?.runs?.length) return s
          const runs = [...a.runs]
          runs[runs.length - 1] = { ...runs[runs.length - 1], status: 'failed', completedAt: now() }
          const newForest = { ...s.forest, nodes: { ...s.forest.nodes, [actionId]: { ...a, runs, status: 'rejection' as CoordNode['status'] } } }
          persist(projectId, { ...get(), forest: newForest }, repository)
          return { forest: newForest, convergenceReport: analyzeConvergence(newForest) }
        })
      }
    },

    dispatchActionPrompt: async (actionId: string, prompt: string) => {
      const trimmed = prompt.trim()
      if (!trimmed) return

      const newRun: AgentRun = {
        runId: nextId('run'),
        provider: 'opencode-acp',
        status: 'queued',
        startedAt: now(),
        events: [],
        prompt: trimmed,
      }

      set(s => {
        const a = s.forest.nodes[actionId]
        if (!a || a.type !== 'action') return s
        const runs = [...(a.runs ?? []), newRun]
        const updated: CoordNode = {
          ...a,
          label: trimmed.slice(0, 72) || a.label,
          summary: trimmed,
          executor: a.executor ?? { type: 'agent', name: 'OpenCode Agent', provider: 'opencode-acp' },
          status: 'active',
          progress: Math.max(a.progress, 5),
          runs,
          updatedAt: now(),
        }
        const newForest = { ...s.forest, nodes: { ...s.forest.nodes, [actionId]: updated } }
        persist(projectId, { ...get(), forest: newForest }, repository)
        return {
          forest: newForest,
          selectedNodeId: actionId,
          convergenceReport: analyzeConvergence(newForest),
        }
      })

      try {
        const result = await dispatchIntent({
          projectId,
          userId: 'default',
          userName: 'default',
          intent: trimmed,
          providerId: 'opencode-acp',
          context: { selectedNodeId: actionId, workDir: workDirFromForest(get().forest) },
        })
        await get().consumeRunEvents(actionId, result.events)
      } catch (err) {
        console.error('Dispatch prompt failed:', err)
        set(s => {
          const a = s.forest.nodes[actionId]
          if (!a?.runs?.length) return s
          const runs = [...a.runs]
          runs[runs.length - 1] = { ...runs[runs.length - 1], status: 'failed', completedAt: now() }
          const newForest = { ...s.forest, nodes: { ...s.forest.nodes, [actionId]: { ...a, runs, status: 'rejection' as CoordNode['status'] } } }
          persist(projectId, { ...get(), forest: newForest }, repository)
          return { forest: newForest, convergenceReport: analyzeConvergence(newForest) }
        })
      }
    },

    startGoalReview: async (goalId: string) => {
      const state = get()
      const goal = state.forest.nodes[goalId]
      if (!goal || goal.type !== 'goal') return
      const childActions = goal.children
        .map(id => state.forest.nodes[id])
        .filter((n): n is CoordNode => Boolean(n && n.type === 'action'))
      if (childActions.length === 0) {
        set({ lastConnectionError: 'Goal has no child actions to review.' })
        return
      }
      const reviewMark = {
        latestRunId: `review_pending_${now()}`,
        status: 'running' as const,
        summary: 'Goal review is running.',
        updatedAt: now(),
      }
      const markedGoal: CoordNode = { ...goal, status: 'review', review: reviewMark, updatedAt: now() }
      const newForest = { ...state.forest, nodes: { ...state.forest.nodes, [goalId]: markedGoal } }
      set({ forest: newForest, selectedNodeId: goalId, convergenceReport: analyzeConvergence(newForest) })
      persist(projectId, { ...get(), forest: newForest }, repository)
      await useReviewStore.getState().startGoalReview({
        projectId,
        goalId,
        forest: newForest,
        contextIndex: state.contextIndex,
        workDir: workDirFromForest(newForest),
        locale: useShellStore.getState().preferences.locale,
        onCompleted: (pkg) => {
          set(s => {
            const current = s.forest.nodes[goalId]
            if (!current || current.type !== 'goal') return s
            const updated: CoordNode = {
              ...current,
              status: 'testing',
              review: {
                latestRunId: pkg.run.id,
                status: 'completed',
                verdict: pkg.run.overallVerdict,
                summary: pkg.run.summary,
                updatedAt: now(),
              },
              updatedAt: now(),
            }
            const nextForest = { ...s.forest, nodes: { ...s.forest.nodes, [goalId]: updated } }
            persist(projectId, { ...get(), forest: nextForest }, repository)
            return { forest: nextForest, convergenceReport: analyzeConvergence(nextForest) }
          })
        },
        onFailed: (reason) => {
          set(s => {
            const current = s.forest.nodes[goalId]
            if (!current || current.type !== 'goal') return s
            const updated: CoordNode = {
              ...current,
              status: 'active',
              review: {
                latestRunId: current.review?.latestRunId ?? `review_failed_${now()}`,
                status: 'failed',
                verdict: 'blocked',
                summary: reason,
                updatedAt: now(),
              },
              updatedAt: now(),
            }
            const nextForest = { ...s.forest, nodes: { ...s.forest.nodes, [goalId]: updated } }
            persist(projectId, { ...get(), forest: nextForest }, repository)
            return { forest: nextForest, convergenceReport: analyzeConvergence(nextForest) }
          })
        },
      })
    },

    applyGoalReview: (pkg: GoalReviewPackage) => {
      set(s => {
        const goal = s.forest.nodes[pkg.run.goalId]
        if (!goal || goal.type !== 'goal') return s
        const nodes = { ...s.forest.nodes }
        let accepted = 0
        let rejected = 0
        let blocked = 0
        for (const decision of pkg.decisions) {
          const action = nodes[decision.actionId]
          if (!action || action.type !== 'action') continue
          const actionReview = {
            latestRunId: pkg.run.id,
            status: 'applied' as const,
            verdict: decision.verdict,
            confidence: decision.confidence,
            summary: decision.rationale,
            updatedAt: now(),
          }
          const runs = [...(action.runs ?? [])]
          if (runs.length > 0) {
            const latest = runs[runs.length - 1]
            if (decision.verdict === 'accept') {
              runs[runs.length - 1] = {
                ...latest,
                verdict: 'accepted',
                reviewId: pkg.run.id,
                reviewVerdict: 'accepted',
              }
            } else if (decision.verdict === 'reject') {
              runs[runs.length - 1] = {
                ...latest,
                verdict: 'rejected',
                correctionNote: decision.correctionNote ?? decision.rationale,
                correctionReasons: decision.correctionReasons ?? [],
                reviewId: pkg.run.id,
                reviewVerdict: 'rejected',
              }
            }
          }
          if (decision.verdict === 'accept') accepted += 1
          else if (decision.verdict === 'reject') rejected += 1
          else blocked += 1
          const nextStatus: CoordNode['status'] =
            decision.verdict === 'accept' ? 'done' :
            decision.verdict === 'reject' ? 'rejection' :
            'active'
          nodes[action.id] = {
            ...action,
            status: nextStatus,
            runs,
            review: actionReview,
            updatedAt: now(),
          }
        }
        const goalStatus: CoordNode['status'] =
          rejected > 0 ? 'rejection' :
          blocked > 0 ? 'active' :
          'done'
        nodes[goal.id] = {
          ...goal,
          status: goalStatus,
          review: {
            latestRunId: pkg.run.id,
            status: 'applied',
            verdict: pkg.run.overallVerdict,
            summary: pkg.run.summary || `${accepted} accepted, ${rejected} rejected, ${blocked} blocked.`,
            updatedAt: now(),
          },
          updatedAt: now(),
        }
        const newForest = { ...s.forest, nodes }
        persist(projectId, { ...get(), forest: newForest }, repository)
        useReviewStore.getState().discardPackage(pkg.run.id)
        return {
          forest: newForest,
          convergenceReport: analyzeConvergence(newForest),
        }
      })
    },

    updateNodeFields: (nodeId, fields) => {
      set(s => {
        const n = s.forest.nodes[nodeId]
        if (!n) return s
        const nextLabel = fields.label !== undefined ? (fields.label.trim() || n.label) : n.label
        const nextSummary = fields.summary !== undefined ? fields.summary : n.summary
        if (nextLabel === n.label && nextSummary === n.summary) return s
        const updated = { ...n, label: nextLabel, summary: nextSummary, updatedAt: now() }
        const newForest = { ...s.forest, nodes: { ...s.forest.nodes, [nodeId]: updated } }
        persist(projectId, { ...get(), forest: newForest }, repository)
        return { forest: newForest }
      })
    },

    // ── v3: analyzer / forest patch / search ──
    analysisAbort: null,

    applyForestPatch: (patch) => {
      set(s => {
        const merged = applyForestPatchPure(s.forest, patch)
        if (merged === s.forest) return s
        const nextState = {
          forest: merged,
          convergenceReport: analyzeConvergence(merged),
        }
        persist(projectId, { ...get(), ...nextState }, repository)
        return nextState
      })
    },

    initializeFromRepo: async (source) => {
      get().cancelInitialize()
      set(s => {
        const nextForest: CoordForest = {
          ...s.forest,
          source,
          analysis: { ...s.forest.analysis, phase: 'cloning', progress: 0, startedAt: Date.now(), message: 'Starting analyzer…' },
          lifecycle: { ...s.forest.lifecycle, initState: 'analyzing' },
        }
        return { forest: nextForest }
      })

      await new Promise<void>((resolve) => {
        // 通用阶段事件→phase 映射。event.type 形如 'analysis_<phase>'，
        // 直接去前缀转 CoordForest.analysis.phase。
        const applyPhase = (
          phase: CoordForest['analysis']['phase'],
          progress: number,
          message: string | undefined,
        ) => {
          set(s => ({
            forest: {
              ...s.forest,
              analysis: { ...s.forest.analysis, phase, progress, message },
            },
          }))
        }

        const onEvent = (event: AnalyzerStreamEvent) => {
          switch (event.type) {
            case 'analysis_started':
              set(s => ({
                forest: {
                  ...s.forest,
                  analysis: {
                    ...s.forest.analysis,
                    lastRunId: event.payload.runId,
                    phase: 'cloning',
                    progress: 1,
                    startedAt: event.payload.startedAt ?? s.forest.analysis.startedAt,
                  },
                },
              }))
              break
            case 'analysis_cloning':
              applyPhase('cloning', event.payload.progress, event.payload.message)
              break
            case 'analysis_parsing':
              applyPhase('parsing', event.payload.progress, event.payload.message)
              break
            case 'analysis_graph_build':
              applyPhase('graph_build', event.payload.progress, event.payload.message)
              break
            case 'analysis_semantic':
              applyPhase('semantic', event.payload.progress, event.payload.message)
              break
            case 'analysis_indexing':
              applyPhase('indexing', event.payload.progress, event.payload.message)
              break
            case 'analysis_graph_persist':
              applyPhase('indexing', event.payload.progress, event.payload.message)
              break
            case 'analysis_neo4j_write':
              applyPhase('indexing', event.payload.progress, event.payload.message)
              break
            case 'analysis_mapping':
              if (event.payload.patch) get().applyForestPatch(event.payload.patch)
              applyPhase('mapping', event.payload.progress, event.payload.message)
              break
            case 'analysis_progress': {
              // legacy / generic path: trust payload.phase if known
              const phase = event.payload.phase as CoordForest['analysis']['phase']
              applyPhase(phase, event.payload.progress, event.payload.message)
              break
            }
            case 'analysis_completed':
              if (event.payload.patch) get().applyForestPatch(event.payload.patch)
              if (event.payload.forest) {
                const full = event.payload.forest
                set(s => ({
                  forest: { ...full, convergence: s.forest.convergence },
                  convergenceReport: analyzeConvergence(full),
                }))
              }
              set(s => ({
                forest: {
                  ...s.forest,
                  source: event.payload.commitSha
                    ? { ...s.forest.source, commitSha: event.payload.commitSha, lastSyncedAt: Date.now() }
                    : s.forest.source,
                  analysis: {
                    ...s.forest.analysis,
                    phase: 'ready',
                    progress: 100,
                    completedAt: Date.now(),
                    report: event.payload.report ?? s.forest.analysis.report,
                  },
                  lifecycle: { ...s.forest.lifecycle, initState: 'ready' },
                },
                analysisAbort: null,
              }))
              persist(projectId, get(), repository)
              resolve()
              break
            case 'analysis_failed':
              set(s => ({
                forest: {
                  ...s.forest,
                  analysis: { ...s.forest.analysis, phase: 'failed', message: event.payload.reason },
                  lifecycle: { ...s.forest.lifecycle, initState: 'failed' },
                },
                analysisAbort: null,
              }))
              resolve()
              break
          }
        }
        const abort = initializeFromRepoStream(
          { projectId, source, locale: useShellStore.getState().preferences.locale },
          onEvent,
          (err) => {
            console.error('[analyzer] stream error:', err)
            set(s => ({
              forest: {
                ...s.forest,
                analysis: { ...s.forest.analysis, phase: 'failed', message: String(err) },
                lifecycle: { ...s.forest.lifecycle, initState: 'failed' },
              },
              analysisAbort: null,
            }))
            resolve()
          },
        )
        set({ analysisAbort: abort })
      })
    },

    cancelInitialize: () => {
      const a = get().analysisAbort
      if (a) a()
      set({ analysisAbort: null })
    },

    hydrateFromBackend: async (options) => {
      const force = options?.force === true
      try {
        const unified = await fetchCoordinatesState(projectId).catch(() => null)
        const backend = unified?.forest ?? await fetchForestSnapshot(projectId)
        if (unified?.context) set({ contextIndex: unified.context })
        if (!backend) return false
        const current = get().forest

        // 防止覆盖正在进行的分析（除非 force）
        if (!force && current.lifecycle?.initState === 'analyzing') return false

        // 默认策略：仅在当前为空森林（revision=0）或后端更新时替换
        if (!force && current.revision > 0 && backend.revision <= current.revision) {
          return false
        }
        const mergedForest = mergeLocalBrowserForest(backend, current)

        // 基于合并后的 forest 重建 layout positions，保留用户已有的同 id 位置
        const auto = computeMindMapLayout(mergedForest, get().nodePositions)
        const nextPositions: CoordNodePositions = Object.fromEntries(
          auto.nodePositions.map(p => [p.id, { x: p.x, y: p.y }]),
        )

        set(s => ({
          forest: mergedForest,
          nodePositions: nextPositions,
          selectedNodeId: mergedForest.nodes[mergedForest.rootId] ? mergedForest.rootId : s.selectedNodeId,
          selectedEdgeId: null,
          convergenceReport: analyzeConvergence(mergedForest),
          layoutVersion: s.layoutVersion + 1,
        }))
        persist(projectId, get(), repository)
        return true
      } catch (err) {
        console.error('[analyzer] hydrateFromBackend failed:', err)
        return false
      }
    },

    search: async (query, mode = 'hybrid', topK = 20) => {
      const trimmed = query.trim()
      if (!trimmed) return []
      try {
        const result = await searchCode(projectId, trimmed, mode, topK)
        return result.hits
      } catch (err) {
        console.error('[analyzer] search failed:', err)
        return []
      }
    },

    suggestMount: async (intent) => {
      const trimmed = intent.trim()
      if (!trimmed) return []
      try {
        return await suggestMountApi(projectId, trimmed)
      } catch (err) {
        console.error('[analyzer] suggestMount failed:', err)
        return []
      }
    },
  }))

  return store
}

export function useCoordinatesStore(projectId: string, projectName: string) {
  const key = projectId
  if (!stores.has(key)) {
    stores.set(key, createCoordinatesStore(projectId, projectName))
  }
  return stores.get(key)!
}

export function useCoordinatesState<T>(
  projectId: string,
  projectName: string,
  selector: (state: CoordinatesState) => T,
) {
  const store = useCoordinatesStore(projectId, projectName)
  return useStore(store, selector)
}

// ── 智能 Handle 路由：根据源/目标位置自动选择最优连接方向 ──
const RF_NODE_W = 280
const RF_NODE_H = 100

function computeOptimalHandles(
  src: { x: number; y: number },
  tgt: { x: number; y: number },
): { sourceHandle: string; targetHandle: string } {
  const scx = src.x + RF_NODE_W / 2
  const scy = src.y + RF_NODE_H / 2
  const tcx = tgt.x + RF_NODE_W / 2
  const tcy = tgt.y + RF_NODE_H / 2

  const dx = tcx - scx
  const dy = tcy - scy

  if (Math.abs(dx) >= Math.abs(dy)) {
    return {
      sourceHandle: dx >= 0 ? 'right-source' : 'left-source',
      targetHandle: dx >= 0 ? 'left-target'  : 'right-target',
    }
  } else {
    return {
      sourceHandle: dy >= 0 ? 'bottom-source' : 'top-source',
      targetHandle: dy >= 0 ? 'top-target'    : 'bottom-target',
    }
  }
}

export function forestToReactFlow(state: Pick<
  CoordinatesState,
  'forest' | 'nodePositions' | 'selectedNodeId' | 'selectedEdgeId' | 'contextIndex'
>) {
  const layout = computeMindMapLayout(state.forest, state.nodePositions)

  // 构建 position lookup 用于智能路由
  const posMap = new Map<string, { x: number; y: number }>()
  for (const pos of layout.nodePositions) {
    posMap.set(pos.id, { x: pos.x, y: pos.y })
  }

  // Per-node evidence counts derived from forest.links. Feature/action
  // cards render these as a badge so users can tell which nodes are
  // actually bound to real code vs. still-speculative drafts.
  const linkStatsByNode = new Map<string, { files: number; symbols: number }>()
  for (const link of state.forest.links ?? []) {
    const stats = linkStatsByNode.get(link.nodeId) ?? { files: 0, symbols: 0 }
    if (link.anchor.kind === 'file') stats.files += 1
    else if (link.anchor.kind === 'symbol') stats.symbols += 1
    linkStatsByNode.set(link.nodeId, stats)
  }

  // Child-action completion ratio per feature/goal. Unlike a progress bar,
  // "3/5 done" is an objective, countable metric and only exists when
  // the parent actually has child tasks.
  const childDoneByNode = new Map<string, { done: number; total: number }>()
  for (const n of Object.values(state.forest.nodes)) {
    if (n.type !== 'feature' && n.type !== 'goal') continue
    const childIds = n.children ?? []
    if (childIds.length === 0) continue
    let done = 0
    let total = 0
    for (const cid of childIds) {
      const child = state.forest.nodes[cid]
      if (!child || child.type !== 'action') continue
      total += 1
      if (child.status === 'done') done += 1
    }
    if (total > 0) childDoneByNode.set(n.id, { done, total })
  }

  const nodes: Node<{
    node: CoordNode
    position: { x: number; y: number }
    linkStats?: { files: number; symbols: number }
    childDone?: { done: number; total: number }
    contextStats?: {
      inputs: number
      incoming: number
      produced: number
      handoffs: number
      snapshot: boolean
    }
  }>[] = layout.nodePositions.map(pos => {
    const node = state.forest.nodes[pos.id]
    const linkStats = linkStatsByNode.get(pos.id)
    const childDone = childDoneByNode.get(pos.id)
    const contextBindings = state.contextIndex.bindings.filter(b => b.targetKind === 'node' && b.targetId === pos.id)
    const contextStats = {
      inputs: contextBindings.filter(b => b.relation !== 'produces').length,
      incoming: (state.contextIndex.disclosureSuggestions ?? []).filter(
        suggestion => suggestion.targetNodeId === pos.id && suggestion.status === 'pending',
      ).length,
      produced: (state.contextIndex.signals ?? []).filter(signal => signal.sourceNodeId === pos.id).length,
      handoffs: (state.contextIndex.disclosureSuggestions ?? []).filter(
        suggestion =>
          suggestion.sourceNodeId === pos.id &&
          suggestion.targetNodeId !== pos.id &&
          suggestion.status === 'pending',
      ).length,
      snapshot: Boolean(node.context?.lastSnapshotId),
    }
    return {
      id: pos.id,
      type: 'coordNode',
      position: { x: pos.x, y: pos.y },
      width: RF_NODE_W,
      height: RF_NODE_H,
      data: { node, position: { x: pos.x, y: pos.y }, linkStats, childDone, contextStats },
      selected: state.selectedNodeId === pos.id,
    }
  })
  const edges: Edge[] = layout.edgePaths.map(edge => {
    const srcPos = posMap.get(edge.source) ?? { x: 0, y: 0 }
    const tgtPos = posMap.get(edge.target) ?? { x: 0, y: 0 }
    const handles = computeOptimalHandles(srcPos, tgtPos)

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
      type: 'coordEdge',
      selected: state.selectedEdgeId === edge.id,
      animated: edge.type === 'dependency',
      reconnectable: edge.type !== 'hierarchy',
      data: {
        edgeType: edge.type,
        strength: edge.strength,
      },
    }
  })
  return { nodes, edges }
}
