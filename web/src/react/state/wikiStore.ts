// ---------------------------------------------------------------------------
// web/src/react/state/wikiStore.ts — Wiki Zustand store
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import { wikiApi } from '../../lib/api/wiki';
import { evaluationApi, type WikiEvaluation, type WikiPlan, type WikiPlanNode, type WikiPlanWithSummary, type PlanNodeDraft, type PlanStreamEvent } from '../../lib/api/evaluation';
import { TaskNotificationEventType } from '../../lib/api/eventTypes';
import { useNotificationStore } from './notificationStore';
import type {
  WikiSnapshot,
  WikiDocument,
  WikiBlock,
  WikiSourceBinding,
  WikiPatch,
  WikiRefreshDraft,
  WikiSnapshotTree,
} from '../../lib/contracts/wiki';

export type WikiViewMode = 'document' | 'plan';
export type PlanNavView = 'list' | 'detail';
export type RefreshPhase = 'idle' | 'scanning' | 'stale_checking' | 'drafting' | 'completed' | 'failed';

export interface RefreshTaskState {
  taskId: string | null;
  phase: RefreshPhase;
  message: string | null;
  meta: Record<string, unknown> | null;
}

export interface WikiState {
  viewMode: WikiViewMode;
  snapshot: WikiSnapshot | null;
  documents: WikiDocument[];
  blocksById: Record<string, WikiBlock>;
  bindingsById: Record<string, WikiSourceBinding>;
  patchesById: Record<string, WikiPatch>;
  selectedDocumentId: string | null;
  selectedBlockId: string | null;
  searchHighlightQuery: string | null;
  evaluations: WikiEvaluation[];
  patchesSummary: { pending: number; conflict: number };
  patchPanelOpen: boolean;
  loading: { snapshot: boolean; patches: boolean; plans: boolean; drafts: boolean };
  error: string | null;

  // Refresh task real-time state
  refreshTask: RefreshTaskState;

  // Draft state
  draftsById: Record<string, WikiRefreshDraft>;
  draftsSummary: { ready: number; generating: number };
  selectedDraftId: string | null;
  draftPanelOpen: boolean;
  draftPanelLayer: 'list' | 'detail';
  draftSelectedBlockIds: Record<string, string[]>;
  draftEditedContent: Record<string, Record<string, unknown>>;
  draftPreviewActive: boolean;
  draftPreviewId: string | null;

  // UI state
  showReinitConfirm: boolean;
  setShowReinitConfirm: (show: boolean) => void;

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
  setSnapshotLoading: () => void;
  applySnapshotTree: (tree: WikiSnapshotTree) => void;
  applyDocumentUpdate: (documentId: string, update: { blockIds: string[]; pipelineStage: string }, blocks: WikiBlock[]) => void;
  selectDocument: (documentId: string | null) => void;
  selectBlock: (blockId: string | null) => void;
  setSearchHighlightQuery: (query: string | null) => void;
  loadEvaluations: (projectId: string) => Promise<void>;
  deleteEvaluations: (evalIds: string[]) => Promise<void>;
  updateBlockLocally: (block: WikiBlock) => void;
  loadPatches: (projectId: string, status?: string) => Promise<void>;
  togglePatchPanel: () => void;
  reset: () => void;

  // Draft actions
  loadDrafts: (projectId: string, status?: string) => Promise<void>;
  selectDraft: (draftId: string) => void;
  backToDraftList: () => void;
  toggleDraftPanel: () => void;
  toggleDraftBlock: (draftId: string, blockId: string) => void;
  selectAllDraftBlocks: (draftId: string) => void;
  deselectAllDraftBlocks: (draftId: string) => void;
  editDraftBlock: (draftId: string, blockId: string, newContent: unknown) => void;
  applyDraft: (draftId: string, blockIds?: string[]) => Promise<void>;
  discardDraft: (draftId: string) => Promise<void>;
  enterDraftPreview: (draftId: string) => void;
  exitDraftPreview: () => void;

  // Refresh task actions
  setRefreshStarted: (taskId: string) => void;
  handleRefreshEvent: (type: string, data: { taskId: string; message: string; meta?: Record<string, unknown> }) => void;

  // Plan actions
  loadPlans: (projectId: string) => Promise<void>;
  loadActivePlan: (projectId: string) => Promise<void>;
  loadPlanNodes: (planId: string) => Promise<void>;
  setPlanNav: (nav: PlanNavView) => void;
  selectPlan: (planId: string | null) => void;
  confirmPlan: (projectId: string, planId: string) => Promise<void>;
  discardPlan: (planId: string) => Promise<void>;
  deletePlan: (planId: string) => Promise<void>;
  updatePlanNode: (nodeId: string, updates: Partial<Pick<WikiPlanNode, 'title' | 'description' | 'expectedFiles'>>) => Promise<void>;
  deletePlanNode: (nodeId: string) => Promise<void>;
  startPlanGeneration: (projectId: string, snapshotId: string) => void;
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
  searchHighlightQuery: null,
  evaluations: [] as WikiEvaluation[],
  patchesSummary: { pending: 0, conflict: 0 },
  patchPanelOpen: false,
  loading: { snapshot: false, patches: false, plans: false, drafts: false },
  error: null,
  // Refresh task state
  refreshTask: { taskId: null, phase: 'idle', message: null, meta: null } as RefreshTaskState,
  // Draft state
  draftsById: {} as Record<string, WikiRefreshDraft>,
  draftsSummary: { ready: 0, generating: 0 },
  selectedDraftId: null as string | null,
  draftPanelOpen: false,
  draftPanelLayer: 'list' as 'list' | 'detail',
  draftSelectedBlockIds: {} as Record<string, string[]>,
  draftEditedContent: {} as Record<string, Record<string, unknown>>,
  draftPreviewActive: false,
  draftPreviewId: null as string | null,
  showReinitConfirm: false,
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

  setSnapshotLoading: () => {
    set(s => ({ ...s, loading: { ...s.loading, snapshot: true }, error: null }));
  },

  applySnapshotTree: (tree: WikiSnapshotTree) => {
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

    const draftsChanged = prev.draftsSummary.ready !== (tree.draftsSummary?.ready ?? 0)
      || prev.draftsSummary.generating !== (tree.draftsSummary?.generating ?? 0);

    const firstDocId = tree.documents[0]?.id ?? null;
    const currentSelected = prev.selectedDocumentId;
    const savedDocId = !currentSelected ? (localStorage.getItem('wiki-selected-doc') ?? null) : null;
    const restoredId = savedDocId && tree.documents.some(d => d.id === savedDocId) ? savedDocId : null;
    const selectedDocumentId =
      currentSelected && tree.documents.some(d => d.id === currentSelected)
        ? currentSelected
        : (restoredId ?? firstDocId);

    const patch: Partial<WikiState> = {
      loading: { snapshot: false, patches: prev.loading.patches, plans: prev.loading.plans, drafts: prev.loading.drafts },
      error: null,
    };
    if (snapshotChanged) patch.snapshot = tree.snapshot;
    if (docsChanged) patch.documents = tree.documents;
    if (blocksChanged) patch.blocksById = nextBlocksById;
    if (bindingsChanged) patch.bindingsById = nextBindingsById;
    if (patchesChanged) patch.patchesSummary = tree.patchesSummary;
    if (draftsChanged) patch.draftsSummary = tree.draftsSummary ?? { ready: 0, generating: 0 };
    if (selectedDocumentId !== prev.selectedDocumentId) patch.selectedDocumentId = selectedDocumentId;

    set(patch);
  },

  applyDocumentUpdate: (documentId, update, blocks) => {
    const prev = get();
    const docIndex = prev.documents.findIndex(d => d.id === documentId);
    if (docIndex < 0) return;

    const updatedDocs = [...prev.documents];
    updatedDocs[docIndex] = { ...updatedDocs[docIndex], blockIds: update.blockIds, pipelineStage: update.pipelineStage };

    const nextBlocksById = { ...prev.blocksById };
    for (const block of blocks) {
      nextBlocksById[block.id] = block;
    }

    set({
      documents: updatedDocs,
      blocksById: nextBlocksById,
    });
  },

  selectDocument: (documentId) => {
    set({ selectedDocumentId: documentId, selectedBlockId: null })
    if (documentId) {
      try { localStorage.setItem('wiki-selected-doc', documentId) } catch {}
    }
  },

  selectBlock: (blockId) => set({ selectedBlockId: blockId }),

  setSearchHighlightQuery: (query) => set({ searchHighlightQuery: query }),

  loadEvaluations: async (projectId: string) => {
    try {
      const evals = await evaluationApi.list(projectId, 'active')
      set({ evaluations: evals })
    } catch { /* ignore */ }
  },

  deleteEvaluations: async (evalIds: string[]) => {
    await Promise.all(evalIds.map(id => evaluationApi.delete(id)))
    set(s => ({ evaluations: s.evaluations.filter(e => !evalIds.includes(e.id)) }))
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

  // Draft actions
  loadDrafts: async (projectId, status) => {
    set(s => ({ ...s, loading: { ...s.loading, drafts: true } }));
    try {
      const drafts = await wikiApi.getDrafts(projectId, status);
      const draftsById: Record<string, WikiRefreshDraft> = {};
      let ready = 0, generating = 0;
      for (const d of drafts) {
        draftsById[d.id] = d;
        if (d.status === 'ready' || d.status === 'partially_applied') ready++;
        else if (d.status === 'generating') generating++;
      }
      set(s => ({ ...s, draftsById, draftsSummary: { ready, generating }, loading: { ...s.loading, drafts: false } }));
    } catch {
      set(s => ({ ...s, loading: { ...s.loading, drafts: false } }));
    }
  },

  selectDraft: (draftId) => {
    const draft = get().draftsById[draftId];
    if (!draft) return;
    const blockIds = draft.changes.map(c => c.blockId);
    set(s => ({
      ...s,
      selectedDraftId: draftId,
      draftPanelLayer: 'detail',
      draftSelectedBlockIds: { ...s.draftSelectedBlockIds, [draftId]: blockIds },
      selectedDocumentId: draft.documentId,
      selectedBlockId: null,
    }));
    try { localStorage.setItem('wiki-selected-doc', draft.documentId); } catch {}
  },

  backToDraftList: () => set({ selectedDraftId: null, draftPanelLayer: 'list' }),

  toggleDraftPanel: () => set(s => ({ draftPanelOpen: !s.draftPanelOpen })),
  setShowReinitConfirm: (show: boolean) => set({ showReinitConfirm: show }),

  toggleDraftBlock: (draftId, blockId) => {
    set(s => {
      const current = s.draftSelectedBlockIds[draftId] ?? [];
      const next = current.includes(blockId)
        ? current.filter(id => id !== blockId)
        : [...current, blockId];
      return { draftSelectedBlockIds: { ...s.draftSelectedBlockIds, [draftId]: next } };
    });
  },

  selectAllDraftBlocks: (draftId) => {
    const draft = get().draftsById[draftId];
    if (!draft) return;
    const blockIds = draft.changes.map(c => c.blockId);
    set(s => ({ draftSelectedBlockIds: { ...s.draftSelectedBlockIds, [draftId]: blockIds } }));
  },

  deselectAllDraftBlocks: (draftId) => {
    set(s => ({ draftSelectedBlockIds: { ...s.draftSelectedBlockIds, [draftId]: [] } }));
  },

  editDraftBlock: (draftId, blockId, newContent) => {
    set(s => ({
      draftEditedContent: {
        ...s.draftEditedContent,
        [draftId]: { ...(s.draftEditedContent[draftId] ?? {}), [blockId]: newContent },
      },
    }));
  },

  applyDraft: async (draftId, blockIds) => {
    const edits = get().draftEditedContent[draftId];
    try {
      if (edits && Object.keys(edits).length > 0) {
        const changes = Object.entries(edits).map(([blockId, newContent]) => ({ blockId, newContent }));
        await wikiApi.editDraft(draftId, changes);
      } else if (blockIds) {
        await wikiApi.applyPartialDraft(draftId, blockIds);
      } else {
        await wikiApi.applyDraft(draftId);
      }
      set(s => {
        const { [draftId]: _, ...rest } = s.draftsById;
        const { [draftId]: __, ...restEdits } = s.draftEditedContent;
        const { [draftId]: ___, ...restSelected } = s.draftSelectedBlockIds;
        return {
          draftsById: rest,
          draftEditedContent: restEdits,
          draftSelectedBlockIds: restSelected,
          selectedDraftId: null,
          draftPanelLayer: 'list',
          draftsSummary: { ...s.draftsSummary, ready: Math.max(0, s.draftsSummary.ready - 1) },
        };
      });
    } catch { /* handled by caller */ }
  },

  discardDraft: async (draftId) => {
    try {
      await wikiApi.discardDraft(draftId);
      set(s => {
        const { [draftId]: _, ...rest } = s.draftsById;
        const { [draftId]: __, ...restEdits } = s.draftEditedContent;
        const { [draftId]: ___, ...restSelected } = s.draftSelectedBlockIds;
        return {
          draftsById: rest,
          draftEditedContent: restEdits,
          draftSelectedBlockIds: restSelected,
          selectedDraftId: s.selectedDraftId === draftId ? null : s.selectedDraftId,
          draftPanelLayer: s.selectedDraftId === draftId ? 'list' : s.draftPanelLayer,
          draftsSummary: { ...s.draftsSummary, ready: Math.max(0, s.draftsSummary.ready - 1) },
        };
      });
    } catch { /* handled by caller */ }
  },

  enterDraftPreview: (draftId) => {
    const draft = get().draftsById[draftId];
    if (!draft) return;
    set({ draftPreviewActive: true, draftPreviewId: draftId, selectedDocumentId: draft.documentId, selectedBlockId: null });
    try { localStorage.setItem('wiki-selected-doc', draft.documentId); } catch {}
  },

  exitDraftPreview: () => {
    set({ draftPreviewActive: false, draftPreviewId: null });
  },

  // Refresh task actions
  setRefreshStarted: (taskId) => {
    set({ refreshTask: { taskId, phase: 'scanning', message: '正在扫描代码索引…', meta: null } });
  },

  handleRefreshEvent: (type, data) => {
    const current = get().refreshTask;
    if (current.taskId && current.taskId !== data.taskId) return;

    if (type === TaskNotificationEventType.TaskProgress) {
      const phase = (data.meta?.phase as RefreshPhase) ?? current.phase;
      set({ refreshTask: { taskId: data.taskId, phase, message: data.message, meta: data.meta ?? null } });
    } else if (type === TaskNotificationEventType.TaskCompleted) {
      set({ refreshTask: { taskId: data.taskId, phase: 'completed', message: data.message, meta: data.meta ?? null } });
    } else if (type === TaskNotificationEventType.TaskFailed) {
      set({ refreshTask: { taskId: data.taskId, phase: 'failed', message: data.message, meta: data.meta ?? null } });
    }
  },

  // Plan actions
  loadPlans: async (projectId: string) => {
    set(s => ({ ...s, loading: { ...s.loading, plans: true } }));
    try {
      const plans = await evaluationApi.listPlans(projectId)
      const { selectedPlanId } = get()
      if (selectedPlanId) {
        set(s => ({ ...s, plans, loading: { ...s.loading, plans: false } }))
      } else {
        const active = plans.find(p => p.status !== 'completed' && p.status !== 'discarded') ?? null
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
    set({ activePlan: null, activePlanNodes: [], selectedPlanId: null, planNav: 'list' })
  },

  deletePlan: async (planId: string) => {
    await evaluationApi.deletePlan(planId)
    set(s => ({
      plans: s.plans.filter(p => p.id !== planId),
      activePlan: s.activePlan?.id === planId ? null : s.activePlan,
      activePlanNodes: s.activePlan?.id === planId ? [] : s.activePlanNodes,
      selectedPlanId: s.selectedPlanId === planId ? null : s.selectedPlanId,
      planNav: s.selectedPlanId === planId ? 'list' as const : s.planNav,
    }))
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

  startPlanGeneration: (projectId: string, snapshotId: string) => {
    const toast = useNotificationStore.getState()
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

    evaluationApi.streamGeneratePlan(projectId, snapshotId, (event) => {
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
        case 'node_submitted':
          set({ planGeneration: { ...s.planGeneration, previewNodes: [...s.planGeneration.previewNodes, event.node] } })
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
