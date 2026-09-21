import type { RuntimeContentPart } from "../../../../lib/api/runtimeMedia";
import type { TurnReference } from "../../../../lib/api/agentRuntime";
import type { BackendId } from "../../../../lib/api/agentRuntime";
import { create } from "zustand";
import { usePendingSubmissionStore } from "./pendingSubmissionStore";
import {
  agentRuntimeApi,
  type AgentInteraction,
  type AgentInteractionReply,
  type AgentSessionMode,
  type AgentRun,
  type AgentRunStep,
  type AgentRuntimeMessage,
  type AgentSession,
  type GitWorkspaceSelection,
  type PermissionDecision,
  type QueuedInput,
  type QueuedMoveTarget,
  type ReasoningEffort,
  type RuntimeEvent,
  type SessionStats,
  type SessionInvocationUsageResponse,
  type TodoItem,
  type ToolCallRecord,
} from "../../../../lib/api/agentRuntime";
import type {
  LlmRetryState,
  SessionLiveEvent,
} from "../../../../lib/api/sessionLive";
import {
  ensureSessionLiveSubscription,
  releaseSessionLiveSubscription,
} from "../../../../lib/api/sessionLiveClient";
import { AppError } from "../../../../lib/errors";
import {
  clearRuntimeResourcePendingRemoval,
  isRuntimeResourceGone,
  isRuntimeResourceRemoved,
  markRuntimeResourcePendingRemoval,
  markRuntimeResourcesRemoved,
} from "../../../../lib/runtimeResourceRegistry";
import {
  SYNAX_PROFILE_ID,
  createSynaxSessionMetadata,
  isAcpSession,
  readSynaxPermissionTier,
  type SynaxPermissionTier,
} from "../synaxSessionTypes";
import { useNotificationStore } from "../../../state/notificationStore";
import { useShellStore } from "../../../state/shellStore";
import {
  patchAgentSession,
  canEnqueueSessionInput,
  canSwitchSessionMode,
} from "../sessionComposerState";
import { useSessionWorkspaceStore } from "./sessionWorkspaceStore";
import type { TurnContentBlock } from "../buildInterleavedTurns";
import {
  EMPTY_STREAMING_BUFFERS,
  applyMessageDelta,
  applyThoughtDelta,
  applyToolCall,
  applyToolResult,
  hasStreamingContent,
  snapshotStreamingBuffers,
  type StreamingLiveBuffers,
} from "../streamingLiveBlocks";
import {
  clearSessionLastVisit,
  loadSessionLastVisit,
} from "../sessionLastVisit";

// Only a missing session itself is terminal, not a missing nested resource,
// unsupported endpoint, permission failure, or transient network error.
function isMissingSession(error: unknown, sessionId: string): boolean {
  return (
    error instanceof AppError &&
    error.statusCode === 404 &&
    error.code === "NOT_FOUND" &&
    error.message === `Agent runtime resource not found: ${sessionId}`
  );
}

const READ_MARKERS_KEY = "synax-session-read-markers";

export type SessionInputBody = {
  contentParts?: RuntimeContentPart[];
  references?: TurnReference[];
  backendId?: BackendId;
  message: string;
  mode?: AgentSessionMode;
  /** `system_injection` renders the message as an "injected" chip, not a bubble. */
  messageSource?: "user" | "system_injection";
  /** Enriched create/turn prompt; defaults to `message` when omitted. */
  prompt?: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  permissionTier?: SynaxPermissionTier;
  skillIds?: string[];
  mcpServerIds?: string[];
  wikiAttachMode?: "auto" | "manual";
  documentId?: string | null;
  gitWorkspace?: GitWorkspaceSelection;
};

/** Stable fallback — never use inline `?? []` in Zustand selectors (breaks getSnapshot caching). */
export const EMPTY_INPUT_QUEUE: QueuedInput[] = [];

function readMarkersStorageKey(projectId: string): string {
  return `${READ_MARKERS_KEY}:${projectId}`;
}

function loadReadMarkers(projectId: string | null): Record<string, string> {
  if (!projectId || typeof localStorage === "undefined") return {};
  const key = readMarkersStorageKey(projectId);
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as Record<string, string>;
    if (typeof sessionStorage !== "undefined") {
      const legacy = sessionStorage.getItem(`${READ_MARKERS_KEY}:${projectId}`);
      if (legacy) {
        localStorage.setItem(key, legacy);
        sessionStorage.removeItem(`${READ_MARKERS_KEY}:${projectId}`);
        return JSON.parse(legacy) as Record<string, string>;
      }
    }
  } catch {
    return {};
  }
  return {};
}

function saveReadMarkers(
  projectId: string | null,
  markers: Record<string, string>,
): void {
  if (!projectId || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      readMarkersStorageKey(projectId),
      JSON.stringify(markers),
    );
  } catch {
    /* quota */
  }
}

/** Sessions that no longer need attention unless explicitly updated after read. */
const ATTENTION_SESSION_STATUSES = new Set<AgentSession["status"]>([
  "running",
  "waiting_permission",
  "waiting_input",
  "queued",
]);

export function isSessionUnread(
  session: AgentSession,
  readMarkers: Record<string, string>,
): boolean {
  const readUpdatedAt = readMarkers[session.id];
  if (!readUpdatedAt) {
    return ATTENTION_SESSION_STATUSES.has(session.status);
  }
  return (
    new Date(session.updatedAt).getTime() > new Date(readUpdatedAt).getTime()
  );
}

const SESSION_PAGE_SIZE = 20;
const SESSION_DETAIL_CACHE_LIMIT = 16;
const SESSION_DETAIL_CACHE_TTL_MS = 45_000;

export interface SessionDetailCacheEntry {
  runs: AgentRun[];
  steps: AgentRunStep[];
  events: RuntimeEvent[];
  messages: AgentRuntimeMessage[];
  toolCalls: ToolCallRecord[];
  permissions: PermissionDecision[];
  sessionStats: SessionStats | null;
  sessionTodos: TodoItem[];
  sessionInvocationUsage: SessionInvocationUsageResponse | null;
  cachedAt: number;
}

let activeSessionsRefresh: {
  projectId: string;
  again: boolean;
  promise: Promise<void>;
} | null = null;

let activeSessionsPage: { projectId: string; promise: Promise<void> } | null =
  null;

let activeDetailRefresh: {
  sessionId: string;
  promise: Promise<void>;
  again: boolean;
} | null = null;
let activeTranscriptRefresh: {
  sessionId: string;
  promise: Promise<void>;
} | null = null;
let detailRefreshEpoch = 0;
let interactionRefreshVersion = 0;

function trimSessionDetailCache(
  cache: Record<string, SessionDetailCacheEntry>,
): Record<string, SessionDetailCacheEntry> {
  const keys = Object.keys(cache);
  if (keys.length <= SESSION_DETAIL_CACHE_LIMIT) return cache;
  const drop = keys
    .sort((a, b) => cache[a].cachedAt - cache[b].cachedAt)
    .slice(0, keys.length - SESSION_DETAIL_CACHE_LIMIT);
  const next = { ...cache };
  for (const key of drop) delete next[key];
  return next;
}

function emptyDetailPayload(): Pick<
  AgentSessionStoreState,
  | "runs"
  | "steps"
  | "events"
  | "messages"
  | "toolCalls"
  | "permissions"
  | "sessionStats"
  | "sessionTodos"
  | "sessionInvocationUsage"
> {
  return {
    runs: [],
    steps: [],
    events: [],
    messages: [],
    toolCalls: [],
    permissions: [],
    sessionStats: null,
    sessionTodos: [],
    sessionInvocationUsage: null,
  };
}

function isActiveSessionStatus(
  status: AgentSession["status"] | undefined,
): boolean {
  return (
    status === "running" ||
    status === "waiting_permission" ||
    status === "waiting_input"
  );
}

type AgentRunStreamChunk = {
  type?: string;
  event?: RuntimeEvent;
  run?: { id: string; status?: AgentRun["status"]; stopReason?: string | null };
  error?: string;
  runId?: string;
  sessionId?: string;
};

function sessionStatusFromRun(
  status: AgentRun["status"] | undefined,
  fallback: "completed" | "failed",
): AgentSession["status"] {
  return status === "blocked" ? "completed" : (status ?? fallback);
}

function applySessionStreamChunk(
  sessionId: string,
  chunk: unknown,
): Partial<AgentSession> | null {
  if (!chunk || typeof chunk !== "object") return null;
  const typed = chunk as AgentRunStreamChunk;
  switch (typed.type) {
    case "event":
      return typed.event?.type === "interaction_requested"
        ? { status: "waiting_input" }
        : null;
    case "run_started":
    case "run_resumed":
      return typed.run
        ? { status: "running", activeRunId: typed.run.id, blockedReason: null }
        : { status: "running" };
    case "permission_requested":
      return typed.runId
        ? { status: "waiting_permission", activeRunId: typed.runId }
        : { status: "waiting_permission" };
    case "interaction_requested":
    case "waiting_input":
      return { status: "waiting_input" };
    case "run_completed":
      return {
        status: sessionStatusFromRun(typed.run?.status, "completed"),
        activeRunId: null,
        pendingResumeToken: null,
        blockedReason: null,
      };
    case "run_failed":
      return {
        status: sessionStatusFromRun(typed.run?.status, "failed"),
        activeRunId: null,
        pendingResumeToken: null,
        ...(typed.run?.status === "blocked" && typed.error
          ? { blockedReason: typed.error }
          : {}),
      };
    case "done":
      return null;
    default:
      return null;
  }
}

function onSessionStreamChunk(sessionId: string, chunk: unknown): void {
  const patch = applySessionStreamChunk(sessionId, chunk);
  if (patch) {
    useAgentSessionStore.getState().patchSession(sessionId, patch);
  }
  if (
    chunk &&
    typeof chunk === "object" &&
    (chunk as { type?: string }).type === "input_injected"
  ) {
    void useAgentSessionStore.getState().loadInputQueue(sessionId);
    if (useAgentSessionStore.getState().selectedSessionId === sessionId) {
      void useAgentSessionStore.getState().refreshDetail();
    }
  }
}

function patchSessionDetailCache(
  sessionId: string,
  patch: Partial<SessionDetailCacheEntry>,
): void {
  const state = useAgentSessionStore.getState();
  const existing = state.sessionDetailCache[sessionId] ?? {
    runs: state.runs,
    steps: state.steps,
    events: state.events,
    messages: state.messages,
    toolCalls: state.toolCalls,
    permissions: state.permissions,
    sessionStats: state.sessionStats,
    sessionTodos: state.sessionTodos,
    sessionInvocationUsage: state.sessionInvocationUsage,
    cachedAt: 0,
  };
  useAgentSessionStore.setState((s) => ({
    sessionDetailCache: trimSessionDetailCache({
      ...s.sessionDetailCache,
      // Profile responses do not make an unfinished transcript fresh.
      [sessionId]: { ...existing, ...patch },
    }),
  }));
}

function ensureLiveStream(sessionId: string): void {
  if (useAgentSessionStore.getState().selectedSessionId !== sessionId) return;
  ensureSessionLiveSubscription(sessionId, (event) => {
    useAgentSessionStore.getState().applyLiveEvent(event);
  });
}

// --- Live-event refresh coalescing -----------------------------------------
// Stream events arrive in bursts; each burst needs one trailing detail
// refresh, not one per event. Polling stays as a low-frequency fallback.
const LIVE_REFRESH_DEBOUNCE_MS = 1200;
let liveDetailRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleLiveRefreshDetail(): void {
  if (liveDetailRefreshTimer) return;
  liveDetailRefreshTimer = setTimeout(() => {
    liveDetailRefreshTimer = null;
    void useAgentSessionStore.getState().refreshDetail();
  }, LIVE_REFRESH_DEBOUNCE_MS);
}

const INVOCATION_USAGE_REFRESH_DEBOUNCE_MS = 500;
let invocationUsageRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleInvocationUsageRefresh(): void {
  if (invocationUsageRefreshTimer) return;
  invocationUsageRefreshTimer = setTimeout(() => {
    invocationUsageRefreshTimer = null;
    void useAgentSessionStore.getState().fetchSessionInvocationUsage();
  }, INVOCATION_USAGE_REFRESH_DEBOUNCE_MS);
}

function clearInvocationUsageRefresh(): void {
  if (invocationUsageRefreshTimer) clearTimeout(invocationUsageRefreshTimer);
  invocationUsageRefreshTimer = null;
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) return [...items, next];
  if (items[index] === next) return items;
  const replaced = [...items];
  replaced[index] = next;
  return replaced;
}

// Batch token bursts at most once every 32 ms, preserving transport order.
// Flush the whole batch at step/tool boundaries so buffered text never moves
// behind a tool or disappears when a fast model starts its next step.
const STREAM_FLUSH_MS = 32;
let deltaBuffer: Array<{ type: "text" | "thinking"; delta: string }> = [];
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushStreamingDeltas(): void {
  if (deltaFlushTimer !== null) clearTimeout(deltaFlushTimer);
  deltaFlushTimer = null;
  if (deltaBuffer.length === 0) return;
  const pending = deltaBuffer;
  deltaBuffer = [];
  useAgentSessionStore.setState((state) => {
    let streamingLive = state.streamingLive;
    for (const item of pending) {
      streamingLive =
        item.type === "thinking"
          ? applyThoughtDelta(streamingLive, item.delta)
          : applyMessageDelta(streamingLive, item.delta);
    }
    return { streamingLive };
  });
}

function bufferStreamingDelta(type: "text" | "thinking", delta: string): void {
  if (!delta) return;
  const last = deltaBuffer[deltaBuffer.length - 1];
  if (last?.type === type) last.delta += delta;
  else deltaBuffer.push({ type, delta });
  // Timers also work when an Electron window is hidden; no parallel rAF and
  // interval loops, artificial typewriter backlog, or permanently idle timers.
  if (deltaFlushTimer === null)
    deltaFlushTimer = setTimeout(flushStreamingDeltas, STREAM_FLUSH_MS);
}

export interface AgentSessionStoreState {
  projectId: string | null;
  draftMode: AgentSessionMode;
  interactionState: {
    sessionId: string;
    items: AgentInteraction[];
    loading: boolean;
    error: string | null;
  } | null;
  sessions: AgentSession[];
  sessionListTotal: number | null;
  sessionListOffset: number;
  sessionListLoading: boolean;
  sessionListError: string | null;
  detailLoading: boolean;
  detailError: string | null;
  selectedSessionId: string | null;
  panelOpen: boolean;
  runs: AgentRun[];
  steps: AgentRunStep[];
  events: RuntimeEvent[];
  messages: AgentRuntimeMessage[];
  toolCalls: ToolCallRecord[];
  childSessions: Record<string, AgentSession[]>;
  permissions: PermissionDecision[];
  sessionStats: SessionStats | null;
  sessionTodos: TodoItem[];
  sessionInvocationUsage: SessionInvocationUsageResponse | null;
  readSessionMarkers: Record<string, string>;
  sessionDetailCache: Record<string, SessionDetailCacheEntry>;

  // 流式进行中状态
  streamingRetry: LlmRetryState | null;
  streamingStepId: string | null;
  streamingLive: StreamingLiveBuffers;
  streamingCompletedSteps: Array<{
    stepId: string;
    stepIndex: number;
    blocks: TurnContentBlock[];
  }>;

  inputQueues: Record<string, QueuedInput[]>;

  setProjectId: (projectId: string | null) => void;
  setDraftMode: (mode: AgentSessionMode) => void;
  refreshInteractions: (sessionId: string) => Promise<void>;
  replyInteraction: (
    sessionId: string,
    interactionId: string,
    body: AgentInteractionReply,
  ) => Promise<void>;
  updateSessionMode: (
    sessionId: string,
    mode: AgentSessionMode,
  ) => Promise<void>;
  refreshSessions: (options?: { joinPending?: boolean }) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  resetSessionDetailForDraft: () => void;
  resetConversationHistory: (sessionId: string) => void;
  submitSessionDraft: (
    projectId: string,
    body: SessionInputBody,
  ) => Promise<AgentSession>;
  deleteSession: (sessionId: string) => Promise<string[]>;
  discardRemovedSessions: (
    sessionIds: string[],
    projectId: string | null,
  ) => void;
  openPanel: (sessionId: string) => void;
  closePanel: () => void;
  refreshDetail: (options?: { joinPending?: boolean }) => Promise<void>;
  fetchChildSessions: (parentId: string) => Promise<void>;
  resumeSession: (sessionId: string, message?: string) => Promise<void>;
  fetchSessionStats: () => Promise<void>;
  fetchSessionTodos: () => Promise<void>;
  fetchSessionInvocationUsage: () => Promise<void>;
  replyPermission: (
    permissionId: string,
    reply: "once" | "always" | "reject",
  ) => Promise<void>;
  updateSessionPermissions: (
    sessionId: string,
    body: { permissionTier?: SynaxPermissionTier },
  ) => Promise<void>;
  sendSessionMessage: (
    sessionId: string,
    body: SessionInputBody,
  ) => Promise<void>;
  submitOrEnqueueSessionInput: (
    sessionId: string,
    body: SessionInputBody,
  ) => Promise<"sent" | "queued">;
  loadInputQueue: (sessionId: string) => Promise<void>;
  enqueueSessionInput: (
    sessionId: string,
    body: SessionInputBody,
  ) => Promise<void>;
  removeQueuedInput: (sessionId: string, itemId: string) => Promise<void>;
  moveQueuedInput: (
    sessionId: string,
    itemId: string,
    target: QueuedMoveTarget,
  ) => Promise<void>;
  forceQueuedInput: (sessionId: string, itemId: string) => Promise<void>;
  setInputQueue: (sessionId: string, items: QueuedInput[]) => void;
  cancelSessionRun: (sessionId: string) => Promise<void>;
  applyLiveEvent: (event: SessionLiveEvent) => void;
  patchSession: (sessionId: string, patch: Partial<AgentSession>) => boolean;
  markSessionRead: (sessionId: string) => void;
}

type SessionDetailState = Pick<
  AgentSessionStoreState,
  | "selectedSessionId"
  | "interactionState"
  | "panelOpen"
  | "runs"
  | "steps"
  | "events"
  | "messages"
  | "toolCalls"
  | "childSessions"
  | "permissions"
  | "sessionStats"
  | "sessionTodos"
  | "sessionInvocationUsage"
  | "streamingRetry"
  | "streamingStepId"
  | "streamingLive"
  | "streamingCompletedSteps"
>;

function emptySessionDetailState(): SessionDetailState {
  return {
    selectedSessionId: null,
    interactionState: null,
    panelOpen: false,
    runs: [],
    steps: [],
    events: [],
    messages: [],
    toolCalls: [],
    childSessions: {},
    permissions: [],
    sessionStats: null,
    sessionTodos: [],
    sessionInvocationUsage: null,
    streamingRetry: null,
    streamingStepId: null,
    streamingLive: EMPTY_STREAMING_BUFFERS,
    streamingCompletedSteps: [],
  };
}

function clearStreamingBuffers(): void {
  deltaBuffer = [];
  if (deltaFlushTimer !== null) clearTimeout(deltaFlushTimer);
  deltaFlushTimer = null;
}

export const useAgentSessionStore = create<AgentSessionStoreState>(
  (set, get) => ({
    projectId: null,
    draftMode: "chat",
    interactionState: null,
    sessions: [],
    sessionListTotal: null,
    sessionListOffset: 0,
    sessionListLoading: false,
    sessionListError: null,
    detailLoading: false,
    detailError: null,
    selectedSessionId: null,
    panelOpen: false,
    runs: [],
    steps: [],
    events: [],
    messages: [],
    toolCalls: [],
    childSessions: {},
    permissions: [],
    sessionStats: null,
    sessionTodos: [],
    sessionInvocationUsage: null,
    readSessionMarkers: {},
    sessionDetailCache: {},
    streamingRetry: null,
    streamingStepId: null,
    streamingLive: EMPTY_STREAMING_BUFFERS,
    streamingCompletedSteps: [],
    inputQueues: {},

    setDraftMode: (draftMode) => set({ draftMode }),

    refreshInteractions: async (sessionId) => {
      if (get().selectedSessionId !== sessionId) return;
      const version = ++interactionRefreshVersion;
      const previous = get().interactionState;
      set({
        interactionState: {
          sessionId,
          items: previous?.sessionId === sessionId ? previous.items : [],
          loading: true,
          error: null,
        },
      });
      try {
        const { interactions } =
          await agentRuntimeApi.listInteractions(sessionId);
        if (
          version !== interactionRefreshVersion ||
          get().selectedSessionId !== sessionId
        )
          return;
        set({
          interactionState: {
            sessionId,
            items: interactions,
            loading: false,
            error: null,
          },
        });
      } catch (error) {
        if (
          version !== interactionRefreshVersion ||
          get().selectedSessionId !== sessionId
        )
          return;
        set({
          interactionState: {
            sessionId,
            items: get().interactionState?.items ?? [],
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },

    replyInteraction: async (sessionId, interactionId, body) => {
      const { interaction } = await agentRuntimeApi.replyInteraction(
        sessionId,
        interactionId,
        body,
      );
      const current = get().interactionState;
      if (
        get().selectedSessionId === sessionId &&
        current?.sessionId === sessionId
      ) {
        // A GET started before this reply must not resurrect its old pending form.
        ++interactionRefreshVersion;
        set({
          interactionState: {
            ...current,
            loading: false,
            error: null,
            items: current.items.map((item) =>
              item.id === interactionId ? interaction : item,
            ),
          },
        });
      }
      void get().refreshSessions();
    },

    updateSessionMode: async (sessionId, mode) => {
      const session = get().sessions.find((s) => s.id === sessionId);
      const interactions = get().interactionState;
      const hasPendingInteractions =
        interactions?.sessionId !== sessionId ||
        interactions.loading ||
        Boolean(interactions.error) ||
        interactions.items.some((item) => item.status === "pending");
      if (
        !session ||
        !canSwitchSessionMode(session, { hasPendingInteractions })
      ) {
        throw new AppError(
          "Mode can only change in an idle native session without pending requests.",
          { level: "business", code: "SESSION_BUSY" },
        );
      }
      const { session: updated } = await agentRuntimeApi.updateSessionMode(
        sessionId,
        mode,
      );
      get().patchSession(sessionId, updated);
    },

    setProjectId: (projectId) => {
      if (projectId === get().projectId) return;
      activeSessionsRefresh = null;
      activeSessionsPage = null;
      activeDetailRefresh = null;
      activeTranscriptRefresh = null;
      clearInvocationUsageRefresh();
      ++detailRefreshEpoch;
      releaseSessionLiveSubscription();
      clearStreamingBuffers();
      set({
        projectId,
        draftMode: "chat",
        sessions: [],
        sessionListTotal: null,
        sessionListOffset: 0,
        sessionListLoading: false,
        sessionListError: null,
        detailLoading: false,
        detailError: null,
        readSessionMarkers: loadReadMarkers(projectId),
        sessionDetailCache: {},
        ...emptySessionDetailState(),
      });
      void get().refreshSessions();
    },

    refreshSessions: async (options) => {
      const { projectId } = get();
      if (!projectId) return;
      if (activeSessionsRefresh?.projectId === projectId) {
        if (!options?.joinPending) activeSessionsRefresh.again = true;
        return activeSessionsRefresh.promise;
      }
      const refresh = { projectId, again: false, promise: Promise.resolve() };
      activeSessionsRefresh = refresh;
      set({ sessionListLoading: true, sessionListError: null });
      refresh.promise = (async () => {
        try {
          do {
            refresh.again = false;
            const before = new Map(
              get().sessions.map((session) => [session.id, session]),
            );
            const { items, totalCount } = await agentRuntimeApi.listSessions({
              projectId,
              limit: SESSION_PAGE_SIZE,
            });
            if (
              activeSessionsRefresh !== refresh ||
              get().projectId !== projectId
            )
              return;
            set((state) => {
              const current = new Map(
                state.sessions.map((session) => [session.id, session]),
              );
              const ids = new Set(items.map((session) => session.id));
              const added = state.sessions.filter(
                (session) =>
                  (!before.has(session.id) ||
                    session.id === state.selectedSessionId ||
                    (items.length === SESSION_PAGE_SIZE &&
                      session.updatedAt <=
                        items[items.length - 1].updatedAt)) &&
                  !ids.has(session.id) &&
                  !isRuntimeResourceGone(session.id),
              );
              const rows = items
                .filter((session) => !isRuntimeResourceGone(session.id))
                .map((session) => {
                  const live = current.get(session.id);
                  // A response snapshot must not overwrite a newer title/live patch.
                  return live &&
                    (live.updatedAt > session.updatedAt ||
                      (live !== before.get(session.id) &&
                        live.updatedAt === session.updatedAt))
                    ? live
                    : live && JSON.stringify(live) === JSON.stringify(session)
                      ? live
                      : session;
                });
              const sessions = [...rows, ...added];
              return {
                sessionListTotal: totalCount,
                sessionListOffset:
                  items.length < SESSION_PAGE_SIZE ||
                  state.sessionListOffset === 0
                    ? items.length
                    : state.sessionListOffset +
                      items.filter((item) => !before.has(item.id)).length,
                sessions:
                  sessions.length === state.sessions.length &&
                  sessions.every((row, i) => row === state.sessions[i])
                    ? state.sessions
                    : sessions,
              };
            });
          } while (refresh.again);
        } catch (error) {
          if (activeSessionsRefresh === refresh)
            set({ sessionListError: String(error) });
        } finally {
          if (activeSessionsRefresh === refresh) {
            activeSessionsRefresh = null;
            set({ sessionListLoading: false });
          }
        }
      })();
      return refresh.promise;
    },

    loadMoreSessions: async () => {
      const { projectId } = get();
      if (!projectId) return;
      if (activeSessionsPage?.projectId === projectId)
        return activeSessionsPage.promise;
      const page = { projectId, promise: Promise.resolve() };
      activeSessionsPage = page;
      page.promise = (async () => {
        try {
          if (activeSessionsRefresh?.projectId === projectId)
            await activeSessionsRefresh.promise;
          if (activeSessionsPage !== page || get().projectId !== projectId)
            return;
          const offset = get().sessionListOffset;
          if (
            get().sessionListTotal !== null &&
            offset >= get().sessionListTotal!
          )
            return;
          set({ sessionListError: null });
          const { items, totalCount } = await agentRuntimeApi.listSessions({
            projectId,
            limit: SESSION_PAGE_SIZE,
            offset,
          });
          if (activeSessionsPage !== page || get().projectId !== projectId)
            return;
          set((state) => {
            const ids = new Set(state.sessions.map((session) => session.id));
            return {
              sessions: [
                ...state.sessions,
                ...items.filter(
                  (session) =>
                    !ids.has(session.id) && !isRuntimeResourceGone(session.id),
                ),
              ],
              sessionListTotal: totalCount,
              sessionListOffset: state.sessionListOffset + items.length,
            };
          });
        } catch (error) {
          if (activeSessionsPage === page)
            set({ sessionListError: String(error) });
        } finally {
          if (activeSessionsPage === page) activeSessionsPage = null;
        }
      })();
      return page.promise;
    },

    resetSessionDetailForDraft: () => {
      ++detailRefreshEpoch;
      clearInvocationUsageRefresh();
      activeDetailRefresh = null;
      activeTranscriptRefresh = null;
      releaseSessionLiveSubscription();
      clearStreamingBuffers();
      set({
        panelOpen: false,
        detailLoading: false,
        detailError: null,
        selectedSessionId: null,
        interactionState: null,
        runs: [],
        steps: [],
        events: [],
        messages: [],
        toolCalls: [],
        permissions: [],
        sessionStats: null,
        sessionTodos: [],
        sessionInvocationUsage: null,
        streamingRetry: null,
        streamingStepId: null,
        streamingLive: EMPTY_STREAMING_BUFFERS,
        streamingCompletedSteps: [],
      });
    },

    submitSessionDraft: async (projectId, body) => {
      const message = body.message.trim();
      if (!message && !body.contentParts?.some((p) => p.type !== "text")) {
        throw new AppError("Session message is required.", {
          level: "business",
          code: "VALIDATION",
        });
      }
      const prompt = body.prompt?.trim() || message || "附件输入 / Media input";
      const wikiAttachMode = body.wikiAttachMode;
      const documentId = body.documentId ?? null;
      const mode = body.mode ?? get().draftMode;
      if (isAcpSession(undefined, body.model) && mode !== "chat") {
        throw new AppError(
          "Plan and goal modes require the native Synax engine.",
          { level: "business", code: "VALIDATION" },
        );
      }
      const payload = await agentRuntimeApi.createSession({
        projectId,
        backendId: body.backendId ?? "native",
        model: body.model ?? undefined,
        profileId: SYNAX_PROFILE_ID,
        prompt,
        reasoningEffort: body.reasoningEffort ?? undefined,
        skillIds: body.skillIds?.length ? body.skillIds : undefined,
        mcpServerIds: body.mcpServerIds?.length ? body.mcpServerIds : undefined,
        permissionTier: body.permissionTier,
        gitWorkspace: body.gitWorkspace,
        sessionMetadata: createSynaxSessionMetadata(mode, {
          source: "session-page",
          userPrompt: message,
          ...(wikiAttachMode ? { wikiAttachMode, documentId } : {}),
        }),
      });
      set((s) =>
        s.projectId !== null && s.projectId !== projectId
          ? s
          : {
              sessions: [
                payload.session,
                ...s.sessions.filter((item) => item.id !== payload.session.id),
              ],
            },
      );
      void get().refreshSessions();
      return payload.session;
    },

    deleteSession: async (sessionId) => {
      const projectId = get().projectId;
      // Suppress this session's in-flight detail requests before the delete
      // lands. They cannot be cancelled once dispatched, so without this the
      // responses arrive as a burst of "resource not found" notifications.
      markRuntimeResourcePendingRemoval(sessionId);
      let deletedSessionIds: string[];
      try {
        ({ deletedSessionIds } =
          await agentRuntimeApi.deleteSession(sessionId));
      } catch (err) {
        clearRuntimeResourcePendingRemoval(sessionId);
        if (!isMissingSession(err, sessionId)) throw err;
        deletedSessionIds = [sessionId];
      }
      get().discardRemovedSessions(deletedSessionIds, projectId);
      return deletedSessionIds;
    },

    discardRemovedSessions: (deletedSessionIds, projectId) => {
      markRuntimeResourcesRemoved(deletedSessionIds);
      const deleted = new Set(deletedSessionIds);
      useSessionWorkspaceStore.getState().removeSessions(deleted);
      const lastVisit = projectId ? loadSessionLastVisit(projectId) : null;
      if (
        projectId &&
        lastVisit?.kind === "session" &&
        deleted.has(lastVisit.sessionId)
      ) {
        clearSessionLastVisit(projectId);
      }
      if (get().projectId !== projectId) return;
      const shouldClosePanel = Boolean(
        get().selectedSessionId && deleted.has(get().selectedSessionId!),
      );
      if (shouldClosePanel) get().resetSessionDetailForDraft();
      const nextCache = { ...get().sessionDetailCache };
      for (const id of deleted) delete nextCache[id];
      set({
        sessions: get().sessions.filter((session) => !deleted.has(session.id)),
        childSessions: Object.fromEntries(
          Object.entries(get().childSessions)
            .filter(([id]) => !deleted.has(id))
            .map(([id, children]) => [
              id,
              children.filter((child) => !deleted.has(child.id)),
            ]),
        ),
        sessionDetailCache: nextCache,
        sessionListTotal:
          get().sessionListTotal === null
            ? null
            : Math.max(0, get().sessionListTotal! - deleted.size),
        sessionListOffset: Math.max(
          0,
          get().sessionListOffset -
            get().sessions.filter((session) => deleted.has(session.id)).length,
        ),
      });
    },

    resetConversationHistory: (sessionId) => {
      ++detailRefreshEpoch;
      activeDetailRefresh = null;
      activeTranscriptRefresh = null;
      const selected = get().selectedSessionId === sessionId;
      if (selected) {
        releaseSessionLiveSubscription();
        clearStreamingBuffers();
      }
      set((state) => {
        const cache = { ...state.sessionDetailCache };
        delete cache[sessionId];
        const childSessions = { ...state.childSessions };
        delete childSessions[sessionId];
        return {
          sessionDetailCache: cache,
          childSessions,
          inputQueues: { ...state.inputQueues, [sessionId]: [] },
          ...(selected
            ? {
                ...emptyDetailPayload(),
                streamingRetry: null,
                streamingStepId: null,
                streamingLive: EMPTY_STREAMING_BUFFERS,
                streamingCompletedSteps: [],
                interactionState: null,
              }
            : {}),
        };
      });
      if (selected) ensureLiveStream(sessionId);
      void get().refreshDetail();
    },

    openPanel: (sessionId) => {
      if (isRuntimeResourceGone(sessionId)) return;
      const { panelOpen, selectedSessionId: prev } = get();
      if (panelOpen && prev === sessionId) return;

      const isSwitch = prev !== sessionId;
      if (isSwitch) {
        ++detailRefreshEpoch;
        clearInvocationUsageRefresh();
        activeDetailRefresh = null;
        activeTranscriptRefresh = null;
      }
      get().markSessionRead(sessionId);
      const session = get().sessions.find((s) => s.id === sessionId);
      const cached = get().sessionDetailCache[sessionId];
      const cacheFresh = Boolean(
        cached &&
        cached.cachedAt > 0 &&
        Date.now() - cached.cachedAt < SESSION_DETAIL_CACHE_TTL_MS,
      );

      set({
        panelOpen: true,
        detailLoading: !cached?.cachedAt,
        detailError: null,
        selectedSessionId: sessionId,
        ...(isSwitch ? { interactionState: null } : {}),
        streamingRetry: null,
        streamingStepId: null,
        streamingLive: EMPTY_STREAMING_BUFFERS,
        streamingCompletedSteps: [],
        ...(cached
          ? {
              runs: cached.runs,
              steps: cached.steps,
              events: cached.events,
              messages: cached.messages,
              toolCalls: cached.toolCalls,
              permissions: cached.permissions,
              sessionStats: cached.sessionStats,
              sessionTodos: cached.sessionTodos,
              sessionInvocationUsage: cached.sessionInvocationUsage,
            }
          : isSwitch
            ? emptyDetailPayload()
            : {}),
      });
      if (isSwitch) clearStreamingBuffers();
      ensureLiveStream(sessionId);
      void get().loadInputQueue(sessionId);

      const needsRefresh =
        !cached || isActiveSessionStatus(session?.status) || !cacheFresh;
      if (needsRefresh) void get().refreshDetail();
    },

    closePanel: () => {
      releaseSessionLiveSubscription();
      clearInvocationUsageRefresh();
      set({ panelOpen: false });
    },

    /**
     * Refresh the selected session's detail.
     *
     * Profile-critical data (stats, todos, invocation usage) is applied as
     * soon as each response lands, and the heavier transcript queries (events,
     * messages, tool calls) are applied in the background. Previously everything
     * was committed in a single batch, so one slow query (the event log can take
     * seconds on long runs) froze the whole side panel.
     */
    refreshDetail: async (options) => {
      const targetSessionId = get().selectedSessionId;
      const targetProjectId = get().projectId;
      if (!targetSessionId) return;
      // A deleted session has nothing left to refresh; without this every poll
      // tick would re-issue the full nine-request burst against a dead id.
      if (isRuntimeResourceGone(targetSessionId)) return;

      if (activeDetailRefresh?.sessionId === targetSessionId) {
        if (!options?.joinPending) activeDetailRefresh.again = true;
        return activeDetailRefresh.promise;
      }

      if (
        options?.joinPending &&
        activeTranscriptRefresh?.sessionId === targetSessionId
      )
        return activeTranscriptRefresh.promise;
      set({
        detailLoading: !get().sessionDetailCache[targetSessionId]?.cachedAt,
        detailError: null,
      });
      const refresh = {
        sessionId: targetSessionId,
        again: false,
        promise: Promise.resolve(),
      };
      const promise = (async () => {
        do {
          refresh.again = false;
          const epoch = ++detailRefreshEpoch;
          try {
            const isCurrent = () =>
              get().selectedSessionId === targetSessionId &&
              get().projectId === targetProjectId &&
              !isRuntimeResourceGone(targetSessionId) &&
              detailRefreshEpoch === epoch &&
              !refresh.again;
            const cachedEntry = get().sessionDetailCache[targetSessionId];
            const knownEventId = cachedEntry?.events?.length
              ? cachedEntry.events[cachedEntry.events.length - 1].id
              : undefined;

            const discardIfMissing = (error: unknown) => {
              if (!isCurrent() || !isMissingSession(error, targetSessionId))
                return false;
              get().discardRemovedSessions([targetSessionId], targetProjectId);
              return true;
            };
            const profileUpdates = [
              ...(!get().sessions.some(
                (session) => session.id === targetSessionId,
              )
                ? [
                    agentRuntimeApi
                      .getSession(targetSessionId)
                      .then(({ session }) => {
                        if (
                          !isCurrent() ||
                          session.projectId !== targetProjectId
                        )
                          return;
                        set((state) => ({
                          sessions: state.sessions.some(
                            (item) => item.id === session.id,
                          )
                            ? state.sessions
                            : [...state.sessions, session],
                        }));
                      })
                      .catch((error) => {
                        discardIfMissing(error);
                        /* Other transcript errors provide the retry UI. */
                      }),
                  ]
                : []),
              agentRuntimeApi
                .getSessionStats(targetSessionId)
                .then((stats) => {
                  if (!isCurrent()) return;
                  set({ sessionStats: stats });
                  patchSessionDetailCache(targetSessionId, {
                    sessionStats: stats,
                  });
                })
                .catch(() => {
                  /* stats are optional */
                }),
              agentRuntimeApi
                .getSessionTodos(targetSessionId)
                .then((todosRes) => {
                  if (!isCurrent()) return;
                  set({ sessionTodos: todosRes.items });
                  patchSessionDetailCache(targetSessionId, {
                    sessionTodos: todosRes.items,
                  });
                })
                .catch(() => {
                  /* todos are optional */
                }),
              agentRuntimeApi
                .getSessionInvocationUsage(targetSessionId)
                .then((usage) => {
                  if (!isCurrent()) return;
                  set({ sessionInvocationUsage: usage });
                  patchSessionDetailCache(targetSessionId, {
                    sessionInvocationUsage: usage,
                  });
                })
                .catch(() => {
                  /* retain the most recent successful usage snapshot */
                }),
            ];

            // While a run streams, tool calls stay current through live
            // upserts; refetch only on first load or once the run settles.
            const polledStatus = get().sessions.find(
              (session) => session.id === targetSessionId,
            )?.status;
            const sessionActive = [
              "running",
              "queued",
              "waiting_permission",
              "waiting_input",
            ].includes(polledStatus ?? "");
            const toolCallsSource =
              sessionActive && cachedEntry?.cachedAt
                ? Promise.resolve({ items: get().toolCalls })
                : agentRuntimeApi.listToolCalls(targetSessionId);
            const transcriptTask = Promise.all([
              // Steps and their messages must become visible together. A
              // completed step alone would hide its still-visible live answer.
              agentRuntimeApi.listSessionSteps(targetSessionId),
              agentRuntimeApi.listRuns(targetSessionId),
              agentRuntimeApi.listEvents(targetSessionId, knownEventId),
              agentRuntimeApi.listMessages(targetSessionId),
              toolCallsSource,
              agentRuntimeApi.listPermissions(targetSessionId),
            ])
              .then(
                ([
                  stepsRes,
                  runsRes,
                  eventsRes,
                  messagesRes,
                  toolCallsRes,
                  permissionsRes,
                ]) => {
                  if (!isCurrent()) return;
                  const events =
                    knownEventId && cachedEntry
                      ? [...cachedEntry.events, ...eventsRes.items]
                      : eventsRes.items;
                  // A response requested before completion may lack the final
                  // message. Only a refresh started after completion can retire
                  // the live answer; the completion event schedules that refresh.
                  const preserveLive =
                    sessionActive ||
                    [
                      "running",
                      "queued",
                      "waiting_permission",
                      "waiting_input",
                    ].includes(
                      get().sessions.find((s) => s.id === targetSessionId)
                        ?.status ?? "",
                    );
                  const cacheEntry: SessionDetailCacheEntry = {
                    runs: runsRes.items,
                    steps: stepsRes.items,
                    events,
                    messages: messagesRes.items,
                    toolCalls: toolCallsRes.items,
                    permissions: permissionsRes.items,
                    sessionStats: get().sessionStats,
                    sessionTodos: get().sessionTodos,
                    sessionInvocationUsage: get().sessionInvocationUsage,
                    cachedAt: Date.now(),
                  };

                  set((s) => ({
                    detailLoading: false,
                    detailError: null,
                    runs: cacheEntry.runs,
                    steps: cacheEntry.steps,
                    events: cacheEntry.events,
                    messages: cacheEntry.messages,
                    toolCalls: cacheEntry.toolCalls,
                    permissions: cacheEntry.permissions,
                    sessionDetailCache: trimSessionDetailCache({
                      ...s.sessionDetailCache,
                      [targetSessionId]: cacheEntry,
                    }),
                    ...(preserveLive
                      ? {}
                      : {
                          streamingRetry: null,
                          streamingStepId: null,
                          streamingLive: EMPTY_STREAMING_BUFFERS,
                          streamingCompletedSteps: [],
                        }),
                  }));

                  const session = get().sessions.find(
                    (s) => s.id === targetSessionId,
                  );
                  if (session && session.childSessionIds.length > 0) {
                    void get().fetchChildSessions(targetSessionId);
                  }
                },
              )
              .catch((error) => {
                if (discardIfMissing(error)) return;
                if (isCurrent())
                  set({ detailLoading: false, detailError: String(error) });
              });

            activeTranscriptRefresh = {
              sessionId: targetSessionId,
              promise: transcriptTask,
            };
            void transcriptTask.finally(() => {
              if (activeTranscriptRefresh?.promise === transcriptTask)
                activeTranscriptRefresh = null;
            });
            await Promise.all(profileUpdates);
            // The transcript refresh keeps running without holding the poll loop.
            void transcriptTask;
          } catch {
            /* silent */
          }
        } while (refresh.again && get().selectedSessionId === targetSessionId);
      })();

      refresh.promise = promise;
      activeDetailRefresh = refresh;
      try {
        await promise;
      } finally {
        if (activeDetailRefresh === refresh) {
          activeDetailRefresh = null;
        }
      }
    },

    fetchChildSessions: async (parentId) => {
      try {
        const { items } = await agentRuntimeApi.listSessions();
        const children = items.filter(
          (s) =>
            s.parentSessionId === parentId && !isRuntimeResourceRemoved(s.id),
        );
        set({
          childSessions: { ...get().childSessions, [parentId]: children },
        });
      } catch {
        /* silent */
      }
    },

    resumeSession: async (sessionId, message) => {
      ensureLiveStream(sessionId);
      await agentRuntimeApi.submitRun(
        sessionId,
        { message, locale: useShellStore.getState().preferences.locale },
        crypto.randomUUID(),
        "continue",
      );
      void get().refreshSessions();
      void get().refreshDetail();
    },

    fetchSessionStats: async () => {
      const { selectedSessionId } = get();
      if (!selectedSessionId) return;
      try {
        const stats = await agentRuntimeApi.getSessionStats(selectedSessionId);
        if (get().selectedSessionId !== selectedSessionId) return;
        set({ sessionStats: stats });
        patchSessionDetailCache(selectedSessionId, { sessionStats: stats });
      } catch {
        /* silent */
      }
    },

    fetchSessionTodos: async () => {
      const { selectedSessionId } = get();
      if (!selectedSessionId) return;
      try {
        const { items } =
          await agentRuntimeApi.getSessionTodos(selectedSessionId);
        if (get().selectedSessionId !== selectedSessionId) return;
        set({ sessionTodos: items });
        patchSessionDetailCache(selectedSessionId, { sessionTodos: items });
      } catch {
        /* silent */
      }
    },

    fetchSessionInvocationUsage: async () => {
      const { selectedSessionId } = get();
      if (!selectedSessionId) return;
      try {
        const usage =
          await agentRuntimeApi.getSessionInvocationUsage(selectedSessionId);
        if (get().selectedSessionId !== selectedSessionId) return;
        set({ sessionInvocationUsage: usage });
        patchSessionDetailCache(selectedSessionId, {
          sessionInvocationUsage: usage,
        });
      } catch {
        /* retain the most recent successful usage snapshot */
      }
    },

    replyPermission: async (permissionId, reply) => {
      const { selectedSessionId } = get();
      if (!selectedSessionId) throw new Error("No session selected.");
      const updated = await agentRuntimeApi.replyPermission(
        selectedSessionId,
        permissionId,
        reply,
      );
      if (get().selectedSessionId === selectedSessionId) {
        set((s) => ({
          permissions: s.permissions.map((p) =>
            p.id === permissionId ? updated : p,
          ),
        }));
        void get().refreshDetail();
      }
      useNotificationStore
        .getState()
        .remove(`perm-global-${selectedSessionId}`);
    },

    updateSessionPermissions: async (sessionId, body) => {
      if (body.permissionTier) {
        const current = get().sessions.find((s) => s.id === sessionId);
        if (
          current &&
          readSynaxPermissionTier(current.sessionMetadata) ===
            body.permissionTier
        ) {
          return;
        }
      }
      const payload = await agentRuntimeApi.updateSessionPermissions(
        sessionId,
        body,
      );
      get().patchSession(sessionId, {
        sessionMetadata: payload.session.sessionMetadata,
        updatedAt: payload.session.updatedAt,
      });
    },

    sendSessionMessage: async (sessionId, body) => {
      const requestId = crypto.randomUUID();
      const pending = usePendingSubmissionStore.getState();
      pending.begin(sessionId, {
        requestId,
        message: {
          id: `pending:${requestId}`,
          sessionId,
          runId: null,
          stepId: null,
          role: "user",
          content: body.message,
          contentParts: body.contentParts,
          metadata: {
            source: body.messageSource ?? "user",
            references: body.references,
          },
          createdAt: new Date().toISOString(),
        },
      });
      try {
        ensureLiveStream(sessionId);
        const session = get().sessions.find((s) => s.id === sessionId);
        const mode =
          session &&
          ["interrupted", "cancelled", "failed", "completed"].includes(
            session.status,
          )
            ? "continue"
            : "turn";
        const result = await agentRuntimeApi.submitRun(
          sessionId,
          {
            message: body.message,
            contentParts: body.contentParts,
            messageSource: body.messageSource,
            references: body.references,
            model: body.model ?? undefined,
            reasoningEffort: body.reasoningEffort ?? undefined,
            permissionTier: body.permissionTier,
            locale: useShellStore.getState().preferences.locale,
          },
          requestId,
          mode,
        );
        pending.accept(sessionId, requestId, result.run);
        void get().refreshSessions();
        if (get().selectedSessionId === sessionId) void get().refreshDetail();
      } catch (error) {
        pending.clear(sessionId, requestId);
        throw error;
      }
    },

    submitOrEnqueueSessionInput: async (sessionId, body) => {
      const session = get().sessions.find((s) => s.id === sessionId);
      if (canEnqueueSessionInput(session)) {
        await get().enqueueSessionInput(sessionId, body);
        return "queued";
      }
      await get().sendSessionMessage(sessionId, body);
      return "sent";
    },

    loadInputQueue: async (sessionId) => {
      try {
        const { items } = await agentRuntimeApi.listInputQueue(sessionId);
        get().setInputQueue(sessionId, items);
      } catch {
        /* silent */
      }
    },

    enqueueSessionInput: async (sessionId, body) => {
      const { items } = await agentRuntimeApi.enqueueInput(sessionId, body);
      get().setInputQueue(sessionId, items);
    },

    removeQueuedInput: async (sessionId, itemId) => {
      const { items } = await agentRuntimeApi.removeQueuedInput(
        sessionId,
        itemId,
      );
      get().setInputQueue(sessionId, items);
    },

    forceQueuedInput: async (sessionId, itemId) => {
      const { items } = await agentRuntimeApi.forceQueuedInput(
        sessionId,
        itemId,
      );
      get().setInputQueue(sessionId, items);
    },

    moveQueuedInput: async (sessionId, itemId, target) => {
      try {
        const { items } = await agentRuntimeApi.moveQueuedInput(
          sessionId,
          itemId,
          target,
        );
        get().setInputQueue(sessionId, items);
      } catch (error) {
        await get().loadInputQueue(sessionId);
        throw error;
      }
    },

    setInputQueue: (sessionId, items) => {
      set((s) => ({
        inputQueues: { ...s.inputQueues, [sessionId]: items },
      }));
    },

    cancelSessionRun: async (sessionId) => {
      try {
        await agentRuntimeApi.cancelSession(
          sessionId,
          get().sessions.find((session) => session.id === sessionId)
            ?.activeRunId,
        );
      } finally {
        void get().refreshSessions();
        void get().refreshDetail();
      }
    },

    applyLiveEvent: (event) => {
      switch (event.type) {
        case "runtime_state": {
          get().patchSession(event.sessionId, event.patch);
          if (get().selectedSessionId !== event.sessionId) break;
          const terminal = [
            "completed",
            "failed",
            "cancelled",
            "interrupted",
          ].includes(event.patch.status ?? "");
          if (event.reset) {
            if (terminal && get().streamingStepId) {
              // The persisted transcript arrives later. Keep the visible answer
              // until refreshDetail replaces it and clears live state together.
              flushStreamingDeltas();
              set({ streamingRetry: null });
            } else {
              clearStreamingBuffers();
              set({
                streamingRetry: null,
                streamingStepId: null,
                streamingLive: EMPTY_STREAMING_BUFFERS,
                streamingCompletedSteps: [],
              });
            }
          }
          if (event.refresh) scheduleLiveRefreshDetail();
          if (terminal) void get().fetchSessionInvocationUsage();
          break;
        }
        case "step_started": {
          flushStreamingDeltas();
          const s = get();
          const hasContent =
            s.streamingStepId && hasStreamingContent(s.streamingLive);
          const completedSteps = hasContent
            ? [
                ...s.streamingCompletedSteps,
                {
                  stepId: s.streamingStepId!,
                  stepIndex: s.streamingCompletedSteps.length + 1,
                  blocks: snapshotStreamingBuffers(s.streamingLive),
                },
              ]
            : s.streamingCompletedSteps;
          clearStreamingBuffers();
          set({
            streamingRetry: null,
            streamingStepId: event.stepId,
            streamingLive: EMPTY_STREAMING_BUFFERS,
            streamingCompletedSteps: completedSteps,
            ...(event.step ? { steps: upsertById(s.steps, event.step) } : {}),
          });
          break;
        }
        case "retry_status": {
          if (get().streamingStepId !== event.stepId) break;
          const reset =
            event.retry.phase === "waiting" ||
            event.retry.phase === "group_wait";
          if (reset) clearStreamingBuffers();
          set({
            streamingRetry:
              event.retry.phase === "recovered" ? null : event.retry,
            ...(reset ? { streamingLive: EMPTY_STREAMING_BUFFERS } : {}),
          });
          break;
        }
        case "message_delta":
          if (get().streamingStepId !== event.stepId) break;
          bufferStreamingDelta("text", event.delta);
          break;
        case "thought_delta":
          if (get().streamingStepId !== event.stepId) break;
          bufferStreamingDelta("thinking", event.delta);
          break;
        case "tool_call": {
          if (get().streamingStepId !== event.stepId) break;
          const isNewCall = !get().toolCalls.some(
            (call) => call.id === event.toolCall.id,
          );
          flushStreamingDeltas();
          set((s) => ({
            streamingLive: applyToolCall(s.streamingLive, event.toolCall),
            toolCalls: upsertById(s.toolCalls, event.toolCall),
          }));
          if (isNewCall) scheduleInvocationUsageRefresh();
          break;
        }
        case "tool_result":
          if (get().streamingStepId !== event.stepId) break;
          flushStreamingDeltas();
          set((s) => ({
            streamingLive: applyToolResult(s.streamingLive, event.toolCall),
            toolCalls: upsertById(s.toolCalls, event.toolCall),
          }));
          break;
      }
    },

    markSessionRead: (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId);
      if (!session) return;
      if (get().readSessionMarkers[sessionId] === session.updatedAt) return;
      const readSessionMarkers = {
        ...get().readSessionMarkers,
        [sessionId]: session.updatedAt,
      };
      set({ readSessionMarkers });
      saveReadMarkers(get().projectId ?? session.projectId, readSessionMarkers);
    },

    patchSession: (sessionId, patch) => {
      let patched = false;
      set((s) => {
        const index = s.sessions.findIndex((sess) => sess.id === sessionId);
        if (index === -1) return s;
        patched = true;
        const sessions = [...s.sessions];
        sessions[index] = patchAgentSession(sessions[index], patch);
        return { sessions };
      });
      const terminal =
        patch.status === "completed" ||
        patch.status === "failed" ||
        patch.status === "cancelled" ||
        patch.status === "interrupted";
      if (
        terminal &&
        get().selectedSessionId === sessionId &&
        get().panelOpen
      ) {
        get().markSessionRead(sessionId);
      }
      if (!patched && typeof patch.title === "string") {
        void get().refreshSessions();
      }
      return patched;
    },
  }),
);
