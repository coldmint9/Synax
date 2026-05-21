// ---------------------------------------------------------------------------
// web/src/react/state/wikiStore.ts — Wiki Zustand store
// ---------------------------------------------------------------------------

import { create } from 'zustand';
import { wikiApi } from '../../lib/api/wiki';
import type {
  WikiSnapshot,
  WikiDocument,
  WikiBlock,
  WikiSourceBinding,
  WikiPatch,
} from '../../lib/contracts/wiki';

export interface WikiState {
  snapshot: WikiSnapshot | null;
  documents: WikiDocument[];
  blocksById: Record<string, WikiBlock>;
  bindingsById: Record<string, WikiSourceBinding>;
  patchesById: Record<string, WikiPatch>;
  selectedDocumentId: string | null;
  patchesSummary: { pending: number; conflict: number };
  loading: { snapshot: boolean; patches: boolean };
  error: string | null;

  loadLatest: (projectId: string) => Promise<void>;
  selectDocument: (documentId: string | null) => void;
  updateBlockLocally: (block: WikiBlock) => void;
  loadPatches: (projectId: string, status?: string) => Promise<void>;
  reset: () => void;
}

const initialState = {
  snapshot: null,
  documents: [],
  blocksById: {},
  bindingsById: {},
  patchesById: {},
  selectedDocumentId: null,
  patchesSummary: { pending: 0, conflict: 0 },
  loading: { snapshot: false, patches: false },
  error: null,
};

export const useWikiStore = create<WikiState>((set, get) => ({
  ...initialState,

  loadLatest: async (projectId: string) => {
    set(s => ({ ...s, loading: { ...s.loading, snapshot: true }, error: null }));
    try {
      const tree = await wikiApi.getLatest(projectId);
      const blocksById: Record<string, WikiBlock> = {};
      for (const b of tree.blocks) blocksById[b.id] = b;
      const bindingsById: Record<string, WikiSourceBinding> = {};
      for (const b of tree.sourceBindings) bindingsById[b.id] = b;

      const firstDocId = tree.documents[0]?.id ?? null;
      const currentSelected = get().selectedDocumentId;
      const selectedDocumentId =
        currentSelected && tree.documents.some(d => d.id === currentSelected)
          ? currentSelected
          : firstDocId;

      set({
        snapshot: tree.snapshot,
        documents: tree.documents,
        blocksById,
        bindingsById,
        patchesSummary: tree.patchesSummary,
        selectedDocumentId,
        loading: { snapshot: false, patches: false },
        error: null,
      });
    } catch (err) {
      set(s => ({
        ...s,
        loading: { ...s.loading, snapshot: false },
        error: err instanceof Error ? err.message : 'Failed to load wiki',
      }));
    }
  },

  selectDocument: (documentId) => set({ selectedDocumentId: documentId }),

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
}));
