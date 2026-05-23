// ---------------------------------------------------------------------------
// web/src/react/state/wikiStore.ts — Wiki Zustand store
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import { wikiApi } from '../../lib/api/wiki';
import { evaluationApi, type WikiEvaluation } from '../../lib/api/evaluation';
import type {
  WikiSnapshot,
  WikiDocument,
  WikiBlock,
  WikiSourceBinding,
  WikiPatch,
} from '../../lib/contracts/wiki';

export type WikiViewMode = 'document' | 'plan';

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
  loading: { snapshot: boolean; patches: boolean };
  error: string | null;

  setViewMode: (mode: WikiViewMode) => void;
  loadLatest: (projectId: string) => Promise<void>;
  selectDocument: (documentId: string | null) => void;
  selectBlock: (blockId: string | null) => void;
  loadEvaluations: (projectId: string) => Promise<void>;
  updateBlockLocally: (block: WikiBlock) => void;
  loadPatches: (projectId: string, status?: string) => Promise<void>;
  togglePatchPanel: () => void;
  reset: () => void;
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
  loading: { snapshot: false, patches: false },
  error: null,
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
      const selectedDocumentId =
        currentSelected && tree.documents.some(d => d.id === currentSelected)
          ? currentSelected
          : firstDocId;

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

  selectDocument: (documentId) => set({ selectedDocumentId: documentId, selectedBlockId: null }),

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
}));
