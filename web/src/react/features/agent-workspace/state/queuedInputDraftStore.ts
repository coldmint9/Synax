import { create } from "zustand";
import type { QueuedInput } from "../../../../lib/api/agentRuntime";
import type { DraftMedia } from "../../media/useMediaDraft";

interface QueueDraft {
  item: QueuedInput;
  attachments: DraftMedia[];
}
export const useQueuedInputDraftStore = create<{
  drafts: Record<string, QueueDraft>;
  save: (sessionId: string, draft: QueueDraft) => void;
  clear: (sessionId: string, itemId: string) => void;
}>((set) => ({
  drafts: {},
  save: (sessionId, draft) =>
    set((state) => ({ drafts: { ...state.drafts, [sessionId]: draft } })),
  clear: (sessionId, itemId) =>
    set((state) => {
      if (state.drafts[sessionId]?.item.id !== itemId) return state;
      const drafts = { ...state.drafts };
      delete drafts[sessionId];
      return { drafts };
    }),
}));
