import { useCallback } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  AgentSession,
  BackendId,
  ReasoningEffort,
} from "../../../lib/api/agentRuntime";
import type {
  EffectiveConfig,
  GlobalConfig,
  ProviderDef,
} from "../../../lib/contracts/config";
import {
  buildAgentModelOptions,
  pickDefaultModelSelection,
} from "./composer/modelSelection";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { useAgentDockStore } from "./state/agentDockStore";
import { sessionRuntimeSelection } from "./sessionRuntimeSelection";

export interface SessionComposerSelection {
  providerId: string | null;
  modelId: string | null;
  cliModel: string;
  reasoningEffort: ReasoningEffort;
}

interface SubmittedSelection extends SessionComposerSelection {
  backendId: BackendId;
}

interface SessionComposerSelectionState {
  selections: Record<string, Partial<SessionComposerSelection>>;
  lastSubmittedByProject: Record<string, SubmittedSelection>;
  patch: (key: string, patch: Partial<SessionComposerSelection>) => void;
  rememberSubmission: (
    projectId: string,
    sessionId: string,
    backendId: BackendId,
    selection: SessionComposerSelection,
  ) => void;
}

export function sessionComposerSelectionKey(
  projectId: string,
  sessionId: string | null,
  backendId: BackendId,
) {
  return JSON.stringify([projectId, sessionId, backendId]);
}

// Route/layout remounts and browser reloads must retain choices owned by a session.
export const useSessionComposerSelections =
  create<SessionComposerSelectionState>()(
    persist(
      (set) => ({
        selections: {},
        lastSubmittedByProject: {},
        patch: (key, patch) =>
          set((state) => ({
            selections: {
              ...state.selections,
              [key]: { ...state.selections[key], ...patch },
            },
          })),
        rememberSubmission: (projectId, sessionId, backendId, selection) =>
          set((state) => ({
            selections: {
              ...state.selections,
              [sessionComposerSelectionKey(projectId, sessionId, backendId)]:
                selection,
              [sessionComposerSelectionKey(projectId, null, backendId)]:
                selection,
            },
            lastSubmittedByProject: {
              ...state.lastSubmittedByProject,
              [projectId]: { ...selection, backendId },
            },
          })),
      }),
      {
        name: "synax-session-composer-selections-v1",
        storage: createJSONStorage(() => localStorage),
        partialize: (state) => ({
          selections: state.selections,
          lastSubmittedByProject: state.lastSubmittedByProject,
        }),
      },
    ),
  );

export function useSessionComposerSelection(
  projectId: string,
  session: AgentSession | undefined,
  backendId: BackendId,
  globalConfig: GlobalConfig | null,
  providers: ProviderDef[],
  effectiveConfig: EffectiveConfig | null,
) {
  const key = sessionComposerSelectionKey(
    projectId,
    session?.id ?? null,
    backendId,
  );
  const saved = useSessionComposerSelections((s) => s.selections[key]);
  const patch = useSessionComposerSelections((s) => s.patch);
  const rememberSubmission = useSessionComposerSelections(
    (s) => s.rememberSubmission,
  );
  const lastSubmitted = useSessionComposerSelections(
    (s) => s.lastSubmittedByProject[projectId],
  );
  const runs = useAgentSessionStore((s) =>
    session?.id === s.selectedSessionId
      ? s.runs
      : s.sessionDetailCache[session?.id ?? ""]?.runs,
  );
  const steps = useAgentSessionStore((s) =>
    session?.id === s.selectedSessionId
      ? s.steps
      : s.sessionDetailCache[session?.id ?? ""]?.steps,
  );
  const runtime = sessionRuntimeSelection(session, runs ?? [], steps ?? []);
  const draftProvider = useAgentDockStore((s) => s.composerProviderId);
  const draftModel = useAgentDockStore((s) => s.composerModelId);
  const draftEffort = useAgentDockStore((s) => s.composerReasoningEffort);
  const { apiModels } = buildAgentModelOptions(globalConfig, providers);
  const preferred = effectiveConfig
    ? {
        providerId: effectiveConfig.providerId,
        modelId: effectiveConfig.modelId,
      }
    : null;
  const defaultSelection = pickDefaultModelSelection(apiModels, [], preferred);
  const separator = runtime.model?.indexOf("/") ?? -1;
  const qualifiedModel =
    separator > 0 && runtime.model && separator < runtime.model.length - 1
      ? {
          providerId: runtime.model.slice(0, separator),
          modelId: runtime.model.slice(separator + 1),
        }
      : null;
  const matchingModel =
    qualifiedModel ??
    apiModels.find(
      (item) =>
        item.modelId === runtime.model &&
        item.providerId === effectiveConfig?.providerId,
    ) ??
    apiModels.find((item) => item.modelId === runtime.model);
  const native = backendId === "native";
  const model = runtime.model;
  const submittedDefault =
    !session && lastSubmitted?.backendId === backendId
      ? lastSubmitted
      : undefined;
  const initial: SessionComposerSelection = {
    providerId: native
      ? session
        ? (matchingModel?.providerId ?? defaultSelection?.providerId ?? null)
        : (submittedDefault?.providerId ??
          draftProvider ??
          defaultSelection?.providerId ??
          null)
      : backendId,
    modelId: native
      ? session
        ? (qualifiedModel?.modelId ??
          model ??
          defaultSelection?.modelId ??
          null)
        : (submittedDefault?.modelId ??
          draftModel ??
          defaultSelection?.modelId ??
          null)
      : session
        ? model?.startsWith(`${backendId}/`)
          ? model.slice(backendId.length + 1)
          : (model ?? "default")
        : (submittedDefault?.modelId ?? "default"),
    cliModel: session
      ? (model ?? "default")
      : (submittedDefault?.cliModel ?? "default"),
    reasoningEffort:
      runtime.reasoningEffort ??
      (session ? "high" : (submittedDefault?.reasoningEffort ?? draftEffort)),
  };
  const selection = { ...initial, ...saved };
  const setSelection = useCallback(
    (value: Partial<SessionComposerSelection>) => patch(key, value),
    [key, patch],
  );
  const markSubmitted = useCallback(
    (sessionId: string) =>
      rememberSubmission(projectId, sessionId, backendId, selection),
    [backendId, projectId, rememberSubmission, selection],
  );
  return { ...selection, setSelection, markSubmitted };
}
