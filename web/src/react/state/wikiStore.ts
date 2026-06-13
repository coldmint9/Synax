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
  selectedDocumentId: string | null;
  searchHighlightQuery: string | null;
  evaluations: WikiEvaluation[];
  draftsSummary: { ready: number; generating: number };
  loading: { snapshot: boolean; plans: boolean; drafts: boolean };
  error: string | null;

  refreshTask: RefreshTaskState;

  draftsById: Record<string, WikiRefreshDraft>;
  selectedDraftId: string | null;
  draftPanelOpen: boolean;
  draftPanelLayer: 'list' | 'detail';
  draftSelectedDocumentIds: Record<string, string[]>;
  draftEditedContentMd: Record<string, Record<string, string>>;
  draftPreviewActive: boolean;
  draftPreviewId: string | null;

  showReinitConfirm: boolean;
  setShowReinitConfirm: (show: boolean) => void;

  plans: WikiPlanWithSummary[];
  activePlan: WikiPlan | null;
  activePlanNodes: WikiPlanNode[];
  planNav: PlanNavView;
  selectedPlanId: string | null;

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
  loadProjectSnapshot: (projectId: string) => Promise<void>;
  applySnapshotTree: (tree: WikiSnapshotTree) => void;
  applyDocumentUpdate: (document: WikiDocument) => void;
  selectDocument: (documentId: string | null) => void;
  setSearchHighlightQuery: (query: string | null) => void;
  loadEvaluations: (projectId: string) => Promise<void>;
  deleteEvaluations: (evalIds: string[]) => Promise<void>;
  reset: () => void;
  clearForRegeneration: () => void;

  loadDrafts: (projectId: string, status?: string) => Promise<void>;
  selectDraft: (draftId: string) => void;
  backToDraftList: () => void;
  toggleDraftPanel: () => void;
  toggleDraftChange: (draftId: string, documentId: string) => void;
  selectAllDraftChanges: (draftId: string) => void;
  deselectAllDraftChanges: (draftId: string) => void;
  editDraftChange: (draftId: string, documentId: string, newContentMd: string) => void;
  applyDraft: (draftId: string, documentIds?: string[]) => Promise<void>;
  discardDraft: (draftId: string) => Promise<void>;
  enterDraftPreview: (draftId: string) => void;
  exitDraftPreview: () => void;

  setRefreshStarted: (taskId: string) => void;
  handleRefreshEvent: (type: string, data: { taskId: string; message: string; meta?: Record<string, unknown> }) => void;

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
  selectedDocumentId: null,
  searchHighlightQuery: null,
  evaluations: [] as WikiEvaluation[],
  draftsSummary: { ready: 0, generating: 0 },
  loading: { snapshot: false, plans: false, drafts: false },
  error: null,
  refreshTask: { taskId: null, phase: 'idle', message: null, meta: null } as RefreshTaskState,
  draftsById: {} as Record<string, WikiRefreshDraft>,
  selectedDraftId: null as string | null,
  draftPanelOpen: false,
  draftPanelLayer: 'list' as 'list' | 'detail',
  draftSelectedDocumentIds: {} as Record<string, string[]>,
  draftEditedContentMd: {} as Record<string, Record<string, string>>,
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

function documentChanged(prev: WikiDocument | undefined, next: WikiDocument): boolean {
  if (!prev) return true;
  return prev.updatedAt !== next.updatedAt
    || prev.contentMd !== next.contentMd
    || prev.pipelineStage !== next.pipelineStage
    || prev.references.length !== next.references.length
    || JSON.stringify(prev.references) !== JSON.stringify(next.references);
}

export const useWikiStore = create<WikiState>((set, get) => ({
  ...initialState,

  setViewMode: (mode: WikiViewMode) => set({ viewMode: mode }),

  setSnapshotLoading: () => {
    set(s => ({ ...s, loading: { ...s.loading, snapshot: true }, error: null }));
  },

  loadProjectSnapshot: async (projectId: string) => {
    set(s => ({ ...s, loading: { ...s.loading, snapshot: true }, error: null }));
    try {
      const tree = await wikiApi.getProjectSnapshot(projectId);
      get().applySnapshotTree(tree);
    } catch (err) {
      set(s => ({
        ...s,
        loading: { ...s.loading, snapshot: false },
        error: err instanceof Error ? err.message : 'Failed to load wiki snapshot',
      }));
    }
  },

  applySnapshotTree: (tree: WikiSnapshotTree) => {
    const prev = get();

    const docsChanged = prev.documents.length !== tree.documents.length
      || tree.documents.some((d, i) => documentChanged(prev.documents[i], d));

    const snapshotChanged = !prev.snapshot
      || prev.snapshot.status !== tree.snapshot?.status
      || prev.snapshot.revision !== tree.snapshot?.revision
      || prev.snapshot.documentIds.length !== (tree.snapshot?.documentIds.length ?? 0);

    const draftsChanged = prev.draftsSummary.ready !== (tree.draftsSummary?.ready ?? 0)
      || prev.draftsSummary.generating !== (tree.draftsSummary?.generating ?? 0);

    const isSelectable = (d: { id: string; isSection?: boolean }) => !d.isSection;
    const firstDocId = tree.documents.find(isSelectable)?.id ?? null;
    const currentSelected = prev.selectedDocumentId;
    const savedDocId = !currentSelected ? (localStorage.getItem('wiki-selected-doc') ?? null) : null;
    const restoredId = savedDocId && tree.documents.some(d => d.id === savedDocId && isSelectable(d)) ? savedDocId : null;
    const selectedDocumentId =
      currentSelected && tree.documents.some(d => d.id === currentSelected && isSelectable(d))
        ? currentSelected
        : (restoredId ?? firstDocId);

    const patch: Partial<WikiState> = {
      loading: { snapshot: false, plans: prev.loading.plans, drafts: prev.loading.drafts },
      error: null,
    };
    if (snapshotChanged) patch.snapshot = tree.snapshot;
    if (docsChanged) patch.documents = tree.documents;
    if (draftsChanged) patch.draftsSummary = tree.draftsSummary ?? { ready: 0, generating: 0 };
    if (selectedDocumentId !== prev.selectedDocumentId) patch.selectedDocumentId = selectedDocumentId;

    set(patch);
  },

  applyDocumentUpdate: (document) => {
    const prev = get();
    const docIndex = prev.documents.findIndex(d => d.id === document.id);
    if (docIndex < 0) return;

    const updatedDocs = [...prev.documents];
    updatedDocs[docIndex] = document;
    set({ documents: updatedDocs });
  },

  selectDocument: (documentId) => {
    set({ selectedDocumentId: documentId })
    if (documentId) {
      try { localStorage.setItem('wiki-selected-doc', documentId) } catch {}
    }
  },

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

  reset: () => set(initialState),
  clearForRegeneration: () => set({
    snapshot: null,
    documents: [],
    selectedDocumentId: null,
    searchHighlightQuery: null,
    evaluations: [],
    draftsSummary: { ready: 0, generating: 0 },
    draftsById: {},
    selectedDraftId: null,
    draftPanelOpen: false,
    draftPanelLayer: 'list',
    draftSelectedDocumentIds: {},
    draftEditedContentMd: {},
    draftPreviewActive: false,
    draftPreviewId: null,
    refreshTask: { taskId: null, phase: 'idle', message: null, meta: null },
    error: null,
    loading: { snapshot: false, plans: false, drafts: false },
    viewMode: 'document',
    plans: [],
    activePlan: null,
    activePlanNodes: [],
    planNav: 'detail',
    selectedPlanId: null,
    planGeneration: { ...initialState.planGeneration },
  }),
  setShowReinitConfirm: (show: boolean) => set({ showReinitConfirm: show }),

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
    const documentIds = draft.changes.map(c => c.documentId);
    set(s => ({
      ...s,
      selectedDraftId: draftId,
      draftPanelLayer: 'detail',
      draftSelectedDocumentIds: { ...s.draftSelectedDocumentIds, [draftId]: documentIds },
      selectedDocumentId: draft.documentId,
    }));
    try { localStorage.setItem('wiki-selected-doc', draft.documentId); } catch {}
  },

  backToDraftList: () => set({ selectedDraftId: null, draftPanelLayer: 'list' }),

  toggleDraftPanel: () => set(s => ({ draftPanelOpen: !s.draftPanelOpen })),

  toggleDraftChange: (draftId, documentId) => {
    set(s => {
      const current = s.draftSelectedDocumentIds[draftId] ?? [];
      const next = current.includes(documentId)
        ? current.filter(id => id !== documentId)
        : [...current, documentId];
      return { draftSelectedDocumentIds: { ...s.draftSelectedDocumentIds, [draftId]: next } };
    });
  },

  selectAllDraftChanges: (draftId) => {
    const draft = get().draftsById[draftId];
    if (!draft) return;
    const documentIds = draft.changes.map(c => c.documentId);
    set(s => ({ draftSelectedDocumentIds: { ...s.draftSelectedDocumentIds, [draftId]: documentIds } }));
  },

  deselectAllDraftChanges: (draftId) => {
    set(s => ({ draftSelectedDocumentIds: { ...s.draftSelectedDocumentIds, [draftId]: [] } }));
  },

  editDraftChange: (draftId, documentId, newContentMd) => {
    set(s => ({
      draftEditedContentMd: {
        ...s.draftEditedContentMd,
        [draftId]: { ...(s.draftEditedContentMd[draftId] ?? {}), [documentId]: newContentMd },
      },
    }));
  },

  applyDraft: async (draftId, documentIds) => {
    const edits = get().draftEditedContentMd[draftId];
    try {
      if (edits && Object.keys(edits).length > 0) {
        const changes = Object.entries(edits).map(([documentId, newContentMd]) => ({ documentId, newContentMd }));
        await wikiApi.editDraft(draftId, changes);
      } else if (documentIds) {
        await wikiApi.applyPartialDraft(draftId, documentIds);
      } else {
        await wikiApi.applyDraft(draftId);
      }
      set(s => {
        const { [draftId]: _, ...rest } = s.draftsById;
        const { [draftId]: __, ...restEdits } = s.draftEditedContentMd;
        const { [draftId]: ___, ...restSelected } = s.draftSelectedDocumentIds;
        return {
          draftsById: rest,
          draftEditedContentMd: restEdits,
          draftSelectedDocumentIds: restSelected,
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
        const { [draftId]: __, ...restEdits } = s.draftEditedContentMd;
        const { [draftId]: ___, ...restSelected } = s.draftSelectedDocumentIds;
        return {
          draftsById: rest,
          draftEditedContentMd: restEdits,
          draftSelectedDocumentIds: restSelected,
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
    set({ draftPreviewActive: true, draftPreviewId: draftId, selectedDocumentId: draft.documentId });
    try { localStorage.setItem('wiki-selected-doc', draft.documentId); } catch {}
  },

  exitDraftPreview: () => {
    set({ draftPreviewActive: false, draftPreviewId: null });
  },

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
