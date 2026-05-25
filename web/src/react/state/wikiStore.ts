// ---------------------------------------------------------------------------
// web/src/react/state/wikiStore.ts — Wiki Zustand store
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import { wikiApi } from '../../lib/api/wiki';
import { evaluationApi, type WikiEvaluation, type WikiPlan, type WikiPlanNode, type WikiPlanWithSummary, type PlanNodeDraft, type PlanStreamEvent } from '../../lib/api/evaluation';
import { useToastStore } from './toastStore';
import type {
  WikiSnapshot,
  WikiDocument,
  WikiBlock,
  WikiSourceBinding,
  WikiPatch,
} from '../../lib/contracts/wiki';

export type WikiViewMode = 'document' | 'plan';
export type PlanNavView = 'list' | 'detail';

export interface WikiState {
  viewMode: WikiViewMode;
  snapshot: WikiSnapshot | null;
  documents: WikiDocument[];
  blocksById: Record<string, WikiBlock>;
  bindingsById: Record<string, WikiSourceBinding>;
  patchesById: Record<string, WikiPatch>;
  selectedDocumentId: string | null;
  selectedBlockId: string | null;
  evaluations: WikiEvaluation[];
  patchesSummary: { pending: number; conflict: number };
  patchPanelOpen: boolean;
  loading: { snapshot: boolean; patches: boolean; plans: boolean };
  error: string | null;

  // Plan state
  plans: WikiPlanWithSummary[];
  activePlan: WikiPlan | null;
  activePlanNodes: WikiPlanNode[];
  planNav: PlanNavView;
  selectedPlanId: string | null;

  // Plan generation streaming state
  planGeneration: {
    status: 'idle' | 'generating' | 'completed' | 'failed'
    phase: string | null
    toolCalls: { tool: string; summary: string }[]
    streamingText: string
    previewNodes: PlanNodeDraft[]
    sessionId: string | null
    error: string | null
  };

  setViewMode: (mode: WikiViewMode) => void;
  loadLatest: (projectId: string) => Promise<void>;
  selectDocument: (documentId: string | null) => void;
  selectBlock: (blockId: string | null) => void;
  loadEvaluations: (projectId: string) => Promise<void>;
  updateBlockLocally: (block: WikiBlock) => void;
  loadPatches: (projectId: string, status?: string) => Promise<void>;
  togglePatchPanel: () => void;
  reset: () => void;

  // Plan actions
  loadPlans: (projectId: string) => Promise<void>;
  loadActivePlan: (projectId: string) => Promise<void>;
  loadPlanNodes: (planId: string) => Promise<void>;
  setPlanNav: (nav: PlanNavView) => void;
  selectPlan: (planId: string | null) => void;
  confirmPlan: (projectId: string, planId: string) => Promise<void>;
  discardPlan: (planId: string) => Promise<void>;
  updatePlanNode: (nodeId: string, updates: Partial<Pick<WikiPlanNode, 'title' | 'description' | 'expectedFiles'>>) => Promise<void>;
  deletePlanNode: (nodeId: string) => Promise<void>;
  startPlanGeneration: (projectId: string, snapshotId: string, workDir: string) => void;
  resetPlanGeneration: () => void;
}

const initialState = {
  viewMode: 'document' as WikiViewMode,
  snapshot: null,
  documents: [],
  blocksById: {},
  bindingsById: {},
  patchesById: {},
  selectedDocumentId: null,
  selectedBlockId: null,
  evaluations: [] as WikiEvaluation[],
  patchesSummary: { pending: 0, conflict: 0 },
  patchPanelOpen: false,
  loading: { snapshot: false, patches: false, plans: false },
  error: null,
  plans: [] as WikiPlanWithSummary[],
  activePlan: null as WikiPlan | null,
  activePlanNodes: [] as WikiPlanNode[],
  planNav: 'detail' as PlanNavView,
  selectedPlanId: null as string | null,
  planGeneration: {
    status: 'idle' as 'idle' | 'generating' | 'completed' | 'failed',
    phase: null as string | null,
    toolCalls: [] as { tool: string; summary: string }[],
    streamingText: '',
    previewNodes: [] as PlanNodeDraft[],
    sessionId: null as string | null,
    error: null as string | null,
  },
};

export const useWikiStore = create<WikiState>((set, get) => ({
  ...initialState,

  setViewMode: (mode: WikiViewMode) => set({ viewMode: mode }),

  loadLatest: async (projectId: string) => {
    const state = get();
    const isInitialLoad = !state.snapshot;
    if (isInitialLoad) {
      set(s => ({ ...s, loading: { ...s.loading, snapshot: true }, error: null }));
    }
    try {
      const tree = await wikiApi.getLatest(projectId);
      const prev = get();

      const nextBlocksById: Record<string, WikiBlock> = {};
      let blocksChanged = false;
      for (const b of tree.blocks) {
        nextBlocksById[b.id] = b;
        if (!prev.blocksById[b.id] || prev.blocksById[b.id].updatedAt !== b.updatedAt) {
          blocksChanged = true;
        }
      }
      if (Object.keys(prev.blocksById).length !== tree.blocks.length) blocksChanged = true;

      const nextBindingsById: Record<string, WikiSourceBinding> = {};
      let bindingsChanged = false;
      for (const b of tree.sourceBindings) {
        nextBindingsById[b.id] = b;
        if (!prev.bindingsById[b.id]) bindingsChanged = true;
      }
      if (Object.keys(prev.bindingsById).length !== tree.sourceBindings.length) bindingsChanged = true;

      const docsChanged = prev.documents.length !== tree.documents.length
        || tree.documents.some((d, i) => {
          const p = prev.documents[i];
          return !p || p.id !== d.id || p.updatedAt !== d.updatedAt || p.blockIds.length !== d.blockIds.length;
        });

      const snapshotChanged = !prev.snapshot
        || prev.snapshot.status !== tree.snapshot?.status
        || prev.snapshot.revision !== tree.snapshot?.revision
        || prev.snapshot.documentIds.length !== (tree.snapshot?.documentIds.length ?? 0);

      const patchesChanged = prev.patchesSummary.pending !== tree.patchesSummary.pending
        || prev.patchesSummary.conflict !== tree.patchesSummary.conflict;

      const firstDocId = tree.documents[0]?.id ?? null;
      const currentSelected = prev.selectedDocumentId;
      const savedDocId = !currentSelected ? (localStorage.getItem('wiki-selected-doc') ?? null) : null;
      const restoredId = savedDocId && tree.documents.some(d => d.id === savedDocId) ? savedDocId : null;
      const selectedDocumentId =
        currentSelected && tree.documents.some(d => d.id === currentSelected)
          ? currentSelected
          : (restoredId ?? firstDocId);

      const patch: Partial<WikiState> = {
        loading: { snapshot: false, patches: prev.loading.patches },
        error: null,
      };
      if (snapshotChanged) patch.snapshot = tree.snapshot;
      if (docsChanged) patch.documents = tree.documents;
      if (blocksChanged) patch.blocksById = nextBlocksById;
      if (bindingsChanged) patch.bindingsById = nextBindingsById;
      if (patchesChanged) patch.patchesSummary = tree.patchesSummary;
      if (selectedDocumentId !== prev.selectedDocumentId) patch.selectedDocumentId = selectedDocumentId;

      set(patch as WikiState);
    } catch (err) {
      set(s => ({
        ...s,
        loading: { ...s.loading, snapshot: false },
        error: err instanceof Error ? err.message : 'Failed to load wiki',
      }));
    }
  },

  selectDocument: (documentId) => {
    set({ selectedDocumentId: documentId, selectedBlockId: null })
    if (documentId) {
      try { localStorage.setItem('wiki-selected-doc', documentId) } catch {}
    }
  },

  selectBlock: (blockId) => set({ selectedBlockId: blockId }),

  loadEvaluations: async (projectId: string) => {
    try {
      const evals = await evaluationApi.list(projectId, 'active')
      set({ evaluations: evals })
    } catch { /* ignore */ }
  },

  updateBlockLocally: (block) =>
    set(s => ({ blocksById: { ...s.blocksById, [block.id]: block } })),

  loadPatches: async (projectId, status) => {
    set(s => ({ ...s, loading: { ...s.loading, patches: true } }));
    try {
      const patches = await wikiApi.getPatches(projectId, status);
      const patchesById: Record<string, WikiPatch> = {};
      for (const p of patches) patchesById[p.id] = p;
      set(s => ({ ...s, patchesById, loading: { ...s.loading, patches: false } }));
    } catch {
      set(s => ({ ...s, loading: { ...s.loading, patches: false } }));
    }
  },

  reset: () => set(initialState),
  togglePatchPanel: () => set(s => ({ patchPanelOpen: !s.patchPanelOpen })),

  // Plan actions
  loadPlans: async (projectId: string) => {
    set(s => ({ ...s, loading: { ...s.loading, plans: true } }));
    try {
      const plans = await evaluationApi.listPlans(projectId)
      const { selectedPlanId } = get()
      if (selectedPlanId) {
        set(s => ({ ...s, plans, loading: { ...s.loading, plans: false } }))
      } else {
        const active = plans.find(p => p.status !== 'completed') ?? null
        set(s => ({ ...s, plans, activePlan: active, loading: { ...s.loading, plans: false } }))
      }
    } catch {
      set(s => ({ ...s, loading: { ...s.loading, plans: false } }))
    }
  },

  loadActivePlan: async (projectId: string) => {
    try {
      const { plan, nodes } = await evaluationApi.getActivePlan(projectId)
      const { selectedPlanId } = get()
      if (!selectedPlanId) {
        set({ activePlan: plan, activePlanNodes: nodes })
      }
    } catch { /* ignore */ }
  },

  loadPlanNodes: async (planId: string) => {
    try {
      const nodes = await evaluationApi.getPlanNodes(planId)
      set({ activePlanNodes: nodes })
    } catch { /* ignore */ }
  },

  setPlanNav: (nav: PlanNavView) => set({ planNav: nav }),

  selectPlan: (planId: string | null) => {
    if (!planId) {
      set({ selectedPlanId: null, activePlan: null, activePlanNodes: [], planNav: 'list' })
      return
    }
    const { plans } = get()
    const plan = plans.find(p => p.id === planId) ?? null
    set({ selectedPlanId: planId, activePlan: plan, activePlanNodes: [], planNav: 'detail' })
    evaluationApi.getPlanNodes(planId).then(nodes => {
      if (get().selectedPlanId === planId) {
        set({ activePlanNodes: nodes })
      }
    }).catch(() => {})
  },

  confirmPlan: async (projectId: string, planId: string) => {
    await evaluationApi.confirmPlan(projectId, planId)
    set(s => ({
      activePlan: s.activePlan ? { ...s.activePlan, status: 'confirmed' as const } : null,
    }))
  },

  discardPlan: async (planId: string) => {
    await evaluationApi.discardPlan(planId)
    set({ activePlan: null, activePlanNodes: [], planNav: 'list' })
  },

  updatePlanNode: async (nodeId: string, updates) => {
    const { activePlan } = get()
    if (!activePlan) return
    await evaluationApi.updateNode(activePlan.id, nodeId, updates)
    set(s => ({
      activePlanNodes: s.activePlanNodes.map(n => n.id === nodeId ? { ...n, ...updates } : n),
    }))
  },

  deletePlanNode: async (nodeId: string) => {
    const { activePlan } = get()
    if (!activePlan) return
    await evaluationApi.deleteNode(activePlan.id, nodeId)
    set(s => ({
      activePlanNodes: s.activePlanNodes.filter(n => n.id !== nodeId),
    }))
  },

  startPlanGeneration: (projectId: string, snapshotId: string, workDir: string) => {
    const toast = useToastStore.getState()
    set({
      viewMode: 'plan',
      planGeneration: {
        status: 'generating',
        phase: 'analyzing',
        toolCalls: [],
        streamingText: '',
        previewNodes: [],
        sessionId: null,
        error: null,
      },
    })

    toast.push({
      type: 'info',
      message: '规划生成已启动，Agent 正在分析 Issues…',
      action: { label: '查看进度', onClick: () => set({ viewMode: 'plan' }) },
      duration: 4000,
    })

    evaluationApi.streamGeneratePlan(projectId, snapshotId, workDir, (event) => {
      const s = get()
      switch (event.type) {
        case 'started':
          set({ planGeneration: { ...s.planGeneration, sessionId: event.sessionId } })
          break
        case 'phase':
          set({ planGeneration: { ...s.planGeneration, phase: event.phase } })
          break
        case 'tool_call':
          set({ planGeneration: { ...s.planGeneration, toolCalls: [...s.planGeneration.toolCalls, { tool: event.tool, summary: event.summary }] } })
          break
        case 'thought_delta':
        case 'message_delta':
          set({ planGeneration: { ...s.planGeneration, streamingText: s.planGeneration.streamingText + event.delta } })
          break
        case 'plan_submitted':
          set({ planGeneration: { ...s.planGeneration, previewNodes: event.nodes } })
          break
        case 'completed':
          get().loadActivePlan(projectId).then(() => {
            get().loadPlans(projectId)
            set({ planGeneration: { ...get().planGeneration, status: 'idle' } })
            toast.push({
              type: 'success',
              message: '规划生成完成，可以开始审查节点。',
              action: { label: '查看规划', onClick: () => set({ viewMode: 'plan' }) },
            })
          })
          break
        case 'failed':
          set({ planGeneration: { ...s.planGeneration, status: 'failed', error: event.error } })
          toast.push({
            type: 'error',
            message: `规划生成失败：${event.error}`,
            action: { label: '查看详情', onClick: () => set({ viewMode: 'plan' }) },
            duration: 8000,
          })
          break
      }
    }, (err) => {
      set(s => ({ planGeneration: { ...s.planGeneration, status: 'failed', error: err instanceof Error ? err.message : 'Connection lost' } }))
      toast.push({
        type: 'error',
        message: '与服务器的连接中断，规划可能仍在后台运行。',
        action: { label: '查看状态', onClick: () => set({ viewMode: 'plan' }) },
        duration: 8000,
      })
    })
  },

  resetPlanGeneration: () => {
    set({ planGeneration: { status: 'idle', phase: null, toolCalls: [], streamingText: '', previewNodes: [], sessionId: null, error: null } })
  },
}));
