import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  formatModelReference,
  type AgentModelSelection,
} from "./composer/modelSelection";

interface CommitModelPreference {
  byProject: Record<string, string>;
  remember: (projectId: string, model: string) => void;
}
export const useCommitModelPreference = create<CommitModelPreference>()(
  persist(
    (set) => ({
      byProject: {},
      remember: (projectId, model) =>
        set((state) => ({
          byProject: { ...state.byProject, [projectId]: model },
        })),
    }),
    {
      name: "synax-commit-message-model-v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ byProject: state.byProject }),
    },
  ),
);

export function pickCommitMessageModel(
  models: AgentModelSelection[],
  sessionModel: string | null,
  rememberedModel: string | null,
): AgentModelSelection | null {
  const apiModels = models.filter((option) => option.kind === "api");
  const find = (ref: string | null) =>
    ref &&
    apiModels.find(
      (option) =>
        formatModelReference(option.providerId, option.modelId) === ref ||
        (option.modelId === ref && !ref.includes("/")),
    );
  return find(rememberedModel) || find(sessionModel) || apiModels[0] || null;
}
