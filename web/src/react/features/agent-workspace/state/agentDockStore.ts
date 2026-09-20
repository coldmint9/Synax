import { create } from "zustand";
import type { RuntimeContentPart } from "../../../../lib/api/runtimeMedia";
import { goalApi } from "../../../../lib/api/goal";
import {
  sessionPromptApi,
  type SessionPromptAnchor,
} from "../../../../lib/api/sessionPrompt";
import {
  agentRuntimeApi,
  type ReasoningEffort,
} from "../../../../lib/api/agentRuntime";
import { useNotificationStore } from "../../../state/notificationStore";
import { useShellStore } from "../../../state/shellStore";
import { useWikiStore } from "../../../state/wikiStore";
import { useAgentSessionStore } from "./agentSessionStore";
import {
  SYNAX_PROFILE_ID,
  createSynaxSessionMetadata,
  DEFAULT_SYNAX_PERMISSION_TIER,
  type SynaxPermissionTier,
  type SynaxWikiAttachMode,
} from "../synaxSessionTypes";
import {
  applyDockStreamChunk,
  initialDockSessionState,
  streamDockSessionTurn,
  type DockSessionState,
} from "../dock/dockSessionStream";
import { formatModelReference } from "../composer/modelSelection";

function settleDockAfterRun(dock: AgentDockState): AgentDockState {
  return dock === "expanded" ? "expanded" : "idle";
}

function pushSessionResultToast(final: DockSessionState): void {
  if (final.status === "waiting_permission") return;
  const toast = useNotificationStore.getState();
  if (final.status === "failed") {
    toast.push({
      type: "error",
      message: final.error ?? "Synax 执行失败",
      duration: 6000,
    });
    return;
  }
  if (final.status === "completed") {
    toast.push({
      type: "success",
      message: "Synax 已完成",
      duration: 4000,
    });
  }
}

export type AgentDockState =
  | "idle"
  | "prompt"
  | "input"
  | "working"
  | "expanded";

export interface AgentDockStoreState {
  dockState: AgentDockState;
  composerContent: string;
  composerProviderId: string | null;
  composerModelId: string | null;
  composerDocumentId: string | null;
  composerWikiAttachMode: SynaxWikiAttachMode;
  composerAnchorJson: SessionPromptAnchor | null;
  composerSkillIds: string[];
  composerReasoningEffort: ReasoningEffort;
  composerPermissionTier: SynaxPermissionTier;
  session: DockSessionState;
  setDockState: (state: AgentDockState) => void;
  setComposerContent: (content: string) => void;
  setComposerProviderId: (id: string | null) => void;
  setComposerModelId: (id: string | null) => void;
  setComposerDocumentId: (id: string | null) => void;
  setComposerWikiAttachMode: (mode: SynaxWikiAttachMode) => void;
  setComposerSkillIds: (ids: string[]) => void;
  setComposerReasoningEffort: (effort: ReasoningEffort) => void;
  setPermissionTier: (tier: SynaxPermissionTier) => Promise<void>;
  openComposer: (prefill?: {
    content?: string;
    documentId?: string | null;
    anchor?: SessionPromptAnchor | null;
  }) => void;
  composerContentParts?: RuntimeContentPart[];
  submitSession: (projectId: string) => Promise<void>;
  stopSession: () => void;
  replyPermission: (
    permissionId: string,
    reply: "once" | "always" | "reject",
  ) => Promise<void>;
  resetSession: () => void;
  reset: () => void;
}

const initialState = {
  dockState: "idle" as AgentDockState,
  composerContent: "",
  composerProviderId: null as string | null,
  composerModelId: null as string | null,
  composerDocumentId: null as string | null,
  composerWikiAttachMode: "auto" as SynaxWikiAttachMode,
  composerAnchorJson: null as SessionPromptAnchor | null,
  composerSkillIds: [] as string[],
  composerReasoningEffort: "high" as ReasoningEffort,
  composerPermissionTier: DEFAULT_SYNAX_PERMISSION_TIER,
  session: initialDockSessionState,
  composerContentParts: [] as RuntimeContentPart[],
};

let contextGeneration = 0;

function captureDockContext(): () => boolean {
  const generation = contextGeneration;
  const projectId = useShellStore.getState().currentProjectId;
  return () =>
    generation === contextGeneration &&
    useShellStore.getState().currentProjectId === projectId;
}

/** Agent execution and composer state shared by the workspace and its Wiki dock. */
export const useAgentDockStore = create<AgentDockStoreState>((set, get) => ({
  ...initialState,
  reset: () => {
    contextGeneration += 1;
    set(initialState);
  },

  setDockState: (state) => set({ dockState: state }),
  setComposerContent: (content) => set({ composerContent: content }),
  setComposerProviderId: (id) => set({ composerProviderId: id }),
  setComposerModelId: (id) => set({ composerModelId: id }),
  setComposerDocumentId: (id) => set({ composerDocumentId: id }),
  setComposerWikiAttachMode: (mode) =>
    set((s) => ({
      composerWikiAttachMode: mode,
      composerDocumentId: mode === "auto" ? null : s.composerDocumentId,
      composerAnchorJson: mode === "auto" ? null : s.composerAnchorJson,
    })),
  setComposerSkillIds: (ids) => set({ composerSkillIds: ids }),
  setComposerReasoningEffort: (effort: ReasoningEffort) =>
    set({ composerReasoningEffort: effort }),
  setPermissionTier: async (tier) => {
    const sessionId = get().session.sessionId;
    const isCurrentContext = captureDockContext();
    const isCurrentSession = () =>
      isCurrentContext() && get().session.sessionId === sessionId;
    if (sessionId) {
      try {
        const payload = await agentRuntimeApi.updateSessionPermissions(
          sessionId,
          { permissionTier: tier },
        );
        if (!isCurrentSession()) return;
        useAgentSessionStore.getState().patchSession(sessionId, {
          sessionMetadata: payload.session.sessionMetadata,
          updatedAt: payload.session.updatedAt,
        });
      } catch (error) {
        if (!isCurrentSession()) return;
        throw error;
      }
    }
    if (isCurrentSession()) set({ composerPermissionTier: tier });
  },

  openComposer: (prefill) => {
    const s = get();
    set({
      dockState: "input",
      composerContent: prefill?.content ?? s.composerContent,
      composerDocumentId:
        prefill?.documentId !== undefined
          ? prefill.documentId
          : s.composerDocumentId,
      composerWikiAttachMode:
        prefill?.documentId !== undefined || prefill?.anchor !== undefined
          ? "manual"
          : s.composerWikiAttachMode,
      composerAnchorJson:
        prefill?.anchor !== undefined ? prefill.anchor : s.composerAnchorJson,
    });
  },

  submitSession: async (projectId) => {
    const s = get();
    const content = s.composerContent.trim();
    const contentParts: RuntimeContentPart[] | undefined = s
      .composerContentParts?.length
      ? [
          ...(content ? [{ type: "text" as const, text: content }] : []),
          ...s.composerContentParts,
        ]
      : undefined;
    if (!content && !contentParts?.length) return;
    const isCurrentContext = captureDockContext();
    let targetSessionId = s.session.sessionId;
    const isCurrentSession = () =>
      isCurrentContext() && get().session.sessionId === targetSessionId;
    let draftReleased = false;
    const clearAcceptedDraft = () => {
      if (draftReleased) return;
      draftReleased = true;
      const current = get();
      if (!isCurrentSession()) return;
      if (
        current.composerContent === s.composerContent &&
        JSON.stringify(current.composerContentParts ?? []) ===
          JSON.stringify(s.composerContentParts ?? [])
      ) {
        set({ composerContent: "", composerContentParts: [] });
      }
    };

    const isFollowUp =
      Boolean(s.session.sessionId) &&
      (s.dockState === "expanded" ||
        s.dockState === "input" ||
        s.session.status === "failed" ||
        s.session.status === "completed" ||
        s.session.status === "running" ||
        s.session.status === "waiting_permission");

    const model = formatModelReference(s.composerProviderId, s.composerModelId);

    try {
      if (isFollowUp && s.session.sessionId) {
        const shouldQueue =
          s.session.status === "running" ||
          s.session.status === "waiting_permission";

        if (shouldQueue) {
          const { items } = await agentRuntimeApi.enqueueInput(
            s.session.sessionId,
            { message: content, contentParts, model },
          );
          if (!isCurrentSession()) return;
          useAgentSessionStore
            .getState()
            .setInputQueue(s.session.sessionId, items);
          clearAcceptedDraft();
          return;
        }

        set({
          session: {
            ...s.session,
            status: "running",
            error: null,
            permissions: [],
            streamingThinking: "",
            streamingText: "",
          },
          dockState: s.dockState === "expanded" ? "expanded" : "working",
        });
        await streamDockSessionTurn(
          s.session.sessionId,
          {
            message: content,
            contentParts,
            model,
          },
          (chunk) => {
            if (!isCurrentSession()) return;
            if (
              ["run_started", "run_resumed"].includes(
                (chunk as { type?: string }).type ?? "",
              )
            )
              clearAcceptedDraft();
            set((state) =>
              state.session.sessionId !== targetSessionId
                ? state
                : {
                    session: applyDockStreamChunk(state.session, chunk),
                  },
            );
          },
        );
        if (!isCurrentSession()) return;
        const final = get().session;
        const dock = get().dockState;
        set({
          dockState:
            final.status === "waiting_permission"
              ? "expanded"
              : settleDockAfterRun(dock),
        });
        clearAcceptedDraft();
        pushSessionResultToast(final);
        return;
      }

      const wikiAttachMode = s.composerWikiAttachMode;
      const { prompt, wikiContext } = await sessionPromptApi.build(projectId, {
        mode: "direct",
        content: content || "附件输入 / Media input",
        wikiAttachMode,
        documentId: wikiAttachMode === "manual" ? s.composerDocumentId : null,
        documentTitle:
          wikiAttachMode === "manual" && s.composerDocumentId
            ? (useWikiStore
                .getState()
                .documents.find((d) => d.id === s.composerDocumentId)?.title ??
              null)
            : null,
        anchorJson: wikiAttachMode === "manual" ? s.composerAnchorJson : null,
      });
      if (!isCurrentContext()) return;

      const documentId = wikiContext.documentId;
      const goal = await goalApi.create(projectId, {
        content: content || "附件输入 / Media input",
        scope: documentId ? "document" : "project",
        documentId: documentId ?? null,
        anchorJson: wikiContext.anchorJson,
      });
      if (!isCurrentContext()) return;
      try {
        const goals = await goalApi.list(projectId, "active");
        if (!isCurrentContext()) return;
        useWikiStore.setState({ goals });
      } catch {
        // A failed sidebar refresh does not prevent submitting the session.
      }
      if (!isCurrentContext()) return;

      const payload = await agentRuntimeApi.createSession({
        projectId,
        profileId: SYNAX_PROFILE_ID,
        prompt,
        skillIds:
          s.composerSkillIds.length > 0 ? s.composerSkillIds : undefined,
        reasoningEffort: s.composerReasoningEffort,
        permissionTier: s.composerPermissionTier,
        sessionMetadata: createSynaxSessionMetadata("goal", {
          source: "agent-dock",
          goalId: goal.id,
          documentId: documentId ?? null,
          wikiAttachMode,
          userPrompt: content,
        }),
      });
      if (!isCurrentContext()) return;

      void goalApi.linkLastSession(goal.id, payload.session.id).catch(() => {});

      targetSessionId = payload.session.id;
      if (get().session.sessionId === s.session.sessionId)
        set({
          session: {
            status: "running",
            sessionId: payload.session.id,
            title: payload.session.title,
            promptFallback: content,
            toolCalls: [],
            permissions: [],
            streamingThinking: "",
            streamingText: "",
            error: null,
          },
          dockState: "working",
          composerAnchorJson: null,
          composerSkillIds: [],
          composerReasoningEffort: "high",
        });

      await streamDockSessionTurn(
        payload.session.id,
        {
          model,
          ...(contentParts
            ? {
                contentParts: [
                  ...(content ? [{ type: "text" as const, text: prompt }] : []),
                  ...s.composerContentParts!,
                ],
              }
            : {}),
          reasoningEffort: s.composerReasoningEffort,
        },
        (chunk) => {
          if (!isCurrentSession()) return;
          if (
            ["run_started", "run_resumed"].includes(
              (chunk as { type?: string }).type ?? "",
            )
          )
            clearAcceptedDraft();
          set((state) =>
            state.session.sessionId !== targetSessionId
              ? state
              : {
                  session: applyDockStreamChunk(state.session, chunk),
                },
          );
        },
      );

      if (!isCurrentSession()) return;
      const final = get().session;
      const dock = get().dockState;
      set({
        dockState:
          final.status === "waiting_permission"
            ? "expanded"
            : settleDockAfterRun(dock),
      });
      clearAcceptedDraft();
      pushSessionResultToast(final);
    } catch (err) {
      if (!isCurrentSession()) return;
      const message = err instanceof Error ? err.message : "提交会话失败";
      set((state) => ({
        session: {
          ...state.session,
          status: "failed",
          error: message,
        },
        dockState: state.dockState === "expanded" ? "expanded" : "idle",
      }));
      pushSessionResultToast(get().session);
    }
  },

  stopSession: () => {
    const sessionId = get().session.sessionId;
    if (sessionId) {
      void agentRuntimeApi.cancelSession(sessionId).catch(() => {});
    }
    set({
      session: { ...get().session, status: "failed", error: "已停止" },
      dockState: get().dockState === "expanded" ? "expanded" : "idle",
    });
  },

  replyPermission: async (permissionId, reply) => {
    const sessionId = get().session.sessionId;
    if (!sessionId) throw new Error("No session selected.");
    const isCurrentContext = captureDockContext();
    const isCurrentSession = () =>
      isCurrentContext() && get().session.sessionId === sessionId;
    const updated = await agentRuntimeApi
      .replyPermission(sessionId, permissionId, reply)
      .catch((error) => {
        if (!isCurrentSession()) return null;
        throw error;
      });
    if (!updated || !isCurrentSession()) return;
    set((s) =>
      s.session.sessionId !== sessionId
        ? s
        : {
            session: {
              ...s.session,
              permissions: s.session.permissions.map((p) =>
                p.id === permissionId ? updated : p,
              ),
              status: reply !== "reject" ? "running" : s.session.status,
              error: reply === "reject" ? updated.reason : s.session.error,
            },
          },
    );
    useNotificationStore.getState().remove(`perm-global-${sessionId}`);
    if (useAgentSessionStore.getState().selectedSessionId === sessionId) {
      useAgentSessionStore.setState((s) => ({
        permissions: s.permissions.map((p) =>
          p.id === permissionId ? updated : p,
        ),
      }));
      void useAgentSessionStore.getState().refreshDetail();
    }
  },

  resetSession: () => {
    contextGeneration += 1;
    set({ session: initialDockSessionState });
  },
}));
