import { SESSION_PAGE_SIZE } from "../../../shared/lib/sessionListPaging";
import type {
  HistoryWindowResponse,
  HistoryWindowState,
} from "../../../adapters/transport/agentRuntime";
import type { RuntimeContentPart } from "../../../adapters/transport/runtimeMedia";
import type { TurnReference } from "../../../adapters/transport/agentRuntime";
import type { BackendId } from "../../../adapters/transport/agentRuntime";
import { create } from "zustand";
import { compactSessionTail, isSessionHistoryReading, SESSION_TAIL_RETAIN } from "./sessionTailWindow";
import { mergeRefreshedHistory, prependHistory } from "./historyWindowMerge";
import { hydrateHistoryMessageContent } from "./hydrateHistoryMessageContent";
import {
  detailEntryBytes,
  readPersistedDetail,
  scheduleDeletePersistedDetail,
  schedulePersistDetail,
} from "./sessionCache";
import {
  forgetSessionList,
  forgetSessionsFromLists,
  recallSessionList,
  rememberSessionList,
  resetSessionListCache,
  updateSessionListRows,
} from "./sessionListCache";
import {
  extendTimelineIndex,
  previewTimelineMessage,
  seedTimelineIndex,
  timelineContainsEntry,
} from "./timelineHistoryIndex";
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
} from "../../../adapters/transport/agentRuntime";
import type {
  LlmRetryState,
  SessionLiveEvent,
} from "../../../adapters/transport/sessionLive";
import {
  ensureSessionLiveSubscription,
  releaseSessionLiveSubscription,
} from "../../../adapters/transport/sessionLiveClient";
import { AppError } from "../../../shared/lib/errors";
import {
  clearRuntimeResourcePendingRemoval,
  isRuntimeResourceGone,
  isRuntimeResourceRemoved,
  markRuntimeResourcePendingRemoval,
  markRuntimeResourcesRemoved,
  markRuntimeResourcesRestored,
} from "../../../shared/lib/runtimeResourceRegistry";
import {
  SYNAX_PROFILE_ID,
  createSynaxSessionMetadata,
  readSynaxPermissionTier,
  type SynaxPermissionTier,
} from "../synaxSessionTypes";
import { useNotificationStore } from "../../../shared/state/notificationStore";
import { useShellStore } from "../../../shared/state/shellStore";
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
  hasStreamingText,
  type StreamingLiveBuffers,
} from "../streamingLiveBlocks";
import {
  clearSessionLastVisit,
  loadSessionLastVisit,
} from "../sessionLastVisit";
import {
  attachSnapshotRunIds,
  retirePersistedSnapshots,
  type CompletedLiveStep,
} from "./liveStepRetirement";

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

async function readLatestHistoryWindow(
  sessionId: string,
  since?: string,
): Promise<HistoryWindowResponse> {
  try {
    return since ? await agentRuntimeApi.historyWindow(sessionId, undefined, since)
      : await agentRuntimeApi.historyWindow(sessionId);
  } catch (error) {
    if ((error as { code?: string }).code !== "HISTORY_STALE") throw error;
    // The first read may race a runtime append. Start over from the latest
    // immutable root instead of retrying the expired cursor.
    return agentRuntimeApi.historyWindow(sessionId);
  }
}

const READ_MARKERS_KEY = "synax-session-read-markers";

type ContextCompactionNotice =
  | { status: "running" }
  | {
      status: "completed";
      originalTokens: number;
      compressedTokens: number;
      messageCount: number;
    }
  | { status: "failed"; error: string };

type StoredContextCompaction = {
  status: "running" | "completed" | "failed";
  originalTokens?: number;
  compressedTokens?: number;
  messageCount?: number;
  error?: string;
};
function contextCompactionNotice(
  state?: StoredContextCompaction,
): ContextCompactionNotice | null {
  if (!state) return null;
  if (state.status === "running") return { status: "running" };
  if (state.status === "failed")
    return { status: "failed", error: state.error ?? "上下文压缩失败" };
  return {
    status: "completed",
    originalTokens: state.originalTokens ?? 0,
    compressedTokens: state.compressedTokens ?? 0,
    messageCount: state.messageCount ?? 0,
  };
}

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
  mediaGeneration?: { providerId: string; modelId: string; capability?: "image_generation" | "video_generation" };
  reasoningEffort?: ReasoningEffort | null;
  permissionTier?: SynaxPermissionTier;
  permissionOverrides?: Partial<Record<"read" | "write" | "delete" | "shell" | "task", "allow" | "ask" | "deny">>;
  skillIds?: string[];
  mcpServerIds?: string[];
  gitWorkspace?: GitWorkspaceSelection;
};

/** Stable fallback — never use inline `?? []` in Zustand selectors (breaks getSnapshot caching). */
export const EMPTY_INPUT_QUEUE: QueuedInput[] = [];

function readMarkersStorageKey(projectId: string): string {
  return `${READ_MARKERS_KEY}:${projectId}`;
}

export function loadReadMarkers(projectId: string | null): Record<string, string> {
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

// The persisted cache refills evicted sessions without a round trip, so the
// in-memory tier can stay warm across a wider working set of open sessions.
const SESSION_INACTIVE_PAGE_CACHE_LIMIT = 8;
/**
 * Completed pages are safe to show immediately, but they still need a bounded
 * freshness window so a session revisited later cannot remain stale forever.
 */
export const SESSION_INACTIVE_PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * A snapshot taken after the run settled is the finished transcript. It only
 * changes when the runtime rewrites history (signalled as `historyReset`) or the
 * session starts another run (status becomes active), so it can be trusted far
 * longer than a mid-run page.
 */
export const RESTORED_TERMINAL_TRUST_MS = 30 * 60 * 1000;

function isFreshInactivePageCache(
  cache: SessionDetailCacheEntry | undefined,
  ttl = SESSION_INACTIVE_PAGE_CACHE_TTL_MS,
  now = Date.now(),
): boolean {
  return Boolean(
    cache?.cachedAt &&
      now - cache.cachedAt >= 0 &&
      now - cache.cachedAt < ttl,
  );
}

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
  lastVisitedAt?: number;
  /**
   * Painted from the persisted cache. The value is the runtime status the
   * snapshot was captured under: a copy saved mid-run must be reconciled before
   * a completed session can be trusted, while a completed copy is the finished
   * transcript and only changes on a rewrite or a new run.
   */
  restored?: "active" | "terminal";
  historyWindow?: HistoryWindowState;
  historyPagesLoaded?: boolean;
  timelineMessages?: AgentRuntimeMessage[];
  timelineRuns?: AgentRun[];
  timelineSteps?: AgentRunStep[];
  timelineToolCalls?: ToolCallRecord[];
  timelineIndexLoaded?: boolean;
  timelineIndexError?: string;
  removed?: HistoryWindowResponse["removed"];
  historyDeleted?: Record<string, string[]>;
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
let activeOlderHistory: { sessionId: string; promise: Promise<void> } | null =
  null;
let activeTimelineIndex: { sessionId: string; promise: Promise<void> } | null =
  null;

let activeTranscriptRefresh: {
  sessionId: string;
  promise: Promise<void>;
} | null = null;
let detailRefreshEpoch = 0;
const terminalHistoryErrors = new Map<string, string>();
/**
 * Stats, todos and usage are derived from the whole transcript. Reading them on
 * every panel open (and every poll of a live run) dominated the request burst
 * without ever changing between two consecutive reads.
 */
const PROFILE_REFRESH_MS = 60_000;
const profileFetchedAt = new Map<string, number>();
const visibleProfiles = new Map<string, number>();

export function observeSessionProfile(sessionId: string): () => void {
  visibleProfiles.set(sessionId, (visibleProfiles.get(sessionId) ?? 0) + 1);
  return () => {
    const count = (visibleProfiles.get(sessionId) ?? 1) - 1;
    if (count > 0) visibleProfiles.set(sessionId, count);
    else visibleProfiles.delete(sessionId);
  };
}
function isPermanentHistoryError(error: unknown): boolean {
  const value = error as { code?: string; statusCode?: number } | null;
  return value?.code === "HISTORY_ENTITY_TOO_LARGE" || value?.code === "HISTORY_PAGE_REQUIRED" ||
    (value?.statusCode !== undefined && [400, 401, 403, 413, 422].includes(value.statusCode));
}
let interactionRefreshVersion = 0;
let finalReplyRetryTimer: ReturnType<typeof setTimeout> | null = null;
let finalReplyRetryCount = 0;
const FINAL_REPLY_RETRY_DELAYS = [700, 1400, 2800];

function clearFinalReplyRetry(): void {
  if (finalReplyRetryTimer !== null) clearTimeout(finalReplyRetryTimer);
  finalReplyRetryTimer = null;
  finalReplyRetryCount = 0;
}

function scheduleFinalReplyRetry(sessionId: string): void {
  if (
    finalReplyRetryTimer !== null ||
    finalReplyRetryCount >= FINAL_REPLY_RETRY_DELAYS.length
  )
    return;
  const delay = FINAL_REPLY_RETRY_DELAYS[finalReplyRetryCount++];
  finalReplyRetryTimer = setTimeout(() => {
    finalReplyRetryTimer = null;
    const state = useAgentSessionStore.getState();
    if (
      state.selectedSessionId === sessionId &&
      state.streamingCompletedSteps.length > 0 &&
      isTerminalSessionStatus(
        state.sessions.find((session) => session.id === sessionId)?.status,
      )
    )
      void state.refreshDetail();
  }, delay);
}

function isTerminalSessionStatus(
  status: AgentSession["status"] | undefined,
): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "paused"
  );
}

function trimSessionDetailCache(
  cache: Record<string, SessionDetailCacheEntry>,
  selectedSessionId?: string | null,
): Record<string, SessionDetailCacheEntry> {
  // Account UTF-16 retained payload without allocating JSON copies. Shared
  // objects may be over-counted across entries: conservative is preferable.
  // The same estimator sizes the persisted records.
  const next: Record<string, SessionDetailCacheEntry> = {};
  let remaining = 16 * 1024 * 1024;
  const inactive = Object.keys(cache)
    .filter((key) => key !== selectedSessionId)
    .sort(
      (a, b) =>
        (cache[b].lastVisitedAt ?? cache[b].cachedAt) -
        (cache[a].lastVisitedAt ?? cache[a].cachedAt),
    )
    .slice(0, SESSION_INACTIVE_PAGE_CACHE_LIMIT);
  const keys =
    selectedSessionId && cache[selectedSessionId]
      ? [selectedSessionId, ...inactive]
      : inactive;
  for (const key of keys) {
    const entry = key === selectedSessionId ? cache[key] : compactSessionTail(cache[key]);
    const size = detailEntryBytes(entry, remaining);
    // A large selected transcript or the minimum warm tail must never evict
    // itself. Reclaim optional historical pages before dropping a whole session.
    next[key] = key !== selectedSessionId && size > remaining ? compactSessionTail(entry, true) : entry;
    remaining = Math.max(0, remaining - size);
  }
  return next;
}

/**
 * Transcript snapshots parked for workspaces the user switched away from.
 *
 * Coming back to a workspace should paint the conversation it left, not an
 * empty panel that waits for `history-window`. Only the most recently read
 * entries travel with a workspace: the live tier already bounds itself, and
 * this tier multiplies its budget by the number of remembered workspaces.
 */
const inactiveProjectDetails = new Map<
  string,
  Record<string, SessionDetailCacheEntry>
>();
const REMEMBERED_PROJECT_DETAILS = 4;
const REMEMBERED_PROJECT_DETAIL_ENTRIES = 2;
const REMEMBERED_PROJECT_DETAIL_BYTES = 6 * 1024 * 1024;

function rememberInactiveProjectDetails(
  projectId: string,
  cache: Record<string, SessionDetailCacheEntry>,
): void {
  const recent = Object.entries(cache)
    .sort(
      ([, a], [, b]) =>
        (b.lastVisitedAt ?? b.cachedAt) - (a.lastVisitedAt ?? a.cachedAt),
    )
    .slice(0, REMEMBERED_PROJECT_DETAIL_ENTRIES);
  const retained: Record<string, SessionDetailCacheEntry> = {};
  let remaining = REMEMBERED_PROJECT_DETAIL_BYTES;
  for (const [sessionId, entry] of recent) {
    const size = detailEntryBytes(entry, remaining);
    if (size > remaining) continue;
    retained[sessionId] = entry;
    remaining -= size;
  }
  // Re-insert so iteration order stays least-recently-left first.
  inactiveProjectDetails.delete(projectId);
  if (Object.keys(retained).length > 0)
    inactiveProjectDetails.set(projectId, retained);
  while (inactiveProjectDetails.size > REMEMBERED_PROJECT_DETAILS) {
    const oldest = inactiveProjectDetails.keys().next().value;
    if (oldest === undefined) break;
    inactiveProjectDetails.delete(oldest);
  }
}

function recallInactiveProjectDetails(
  projectId: string,
): Record<string, SessionDetailCacheEntry> {
  const cache = inactiveProjectDetails.get(projectId);
  if (!cache) return {};
  inactiveProjectDetails.delete(projectId);
  return cache;
}

function forgetInactiveProjectDetails(
  projectId: string,
  sessionIds?: readonly string[],
): void {
  if (!sessionIds) {
    inactiveProjectDetails.delete(projectId);
    return;
  }
  const removed = new Set(sessionIds);
  const cache = inactiveProjectDetails.get(projectId);
  if (!cache) return;
  const retained = Object.fromEntries(
    Object.entries(cache).filter(([id]) => !removed.has(id)),
  );
  if (Object.keys(retained).length === 0) inactiveProjectDetails.delete(projectId);
  else inactiveProjectDetails.set(projectId, retained);
}

function forgetSessionsFromInactiveDetails(sessionIds: readonly string[]): void {
  for (const projectId of [...inactiveProjectDetails.keys()])
    forgetInactiveProjectDetails(projectId, sessionIds);
}

/** Copy the live list of `projectId` into the remembered snapshot tier. */
function rememberCurrentSessionList(projectId: string): void {
  const state = useAgentSessionStore.getState();
  if (state.projectId !== projectId) return;
  rememberSessionList(projectId, {
    sessions: state.sessions,
    total: state.sessionListTotal,
    offset: state.sessionListOffset,
    loadedAt: state.sessionListLoadedAt,
  });
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
  // Interrupting a run and launching a forced queued input overlap briefly.
  // The old run can finish publishing after the new run has already started;
  // its terminal event must not put the session back into an interrupted or
  // failed state.
  if (
    chunk &&
    typeof chunk === "object" &&
    ((chunk as { type?: string }).type === "run_completed" ||
      (chunk as { type?: string }).type === "run_failed")
  ) {
    const runId = (chunk as AgentRunStreamChunk).run?.id ??
      (chunk as AgentRunStreamChunk).runId;
    const activeRunId = useAgentSessionStore
      .getState()
      .sessions.find((session) => session.id === sessionId)?.activeRunId;
    if (runId && activeRunId && runId !== activeRunId) return;
  }
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
    lastVisitedAt: Date.now(),
  };
  useAgentSessionStore.setState((s) => ({
    sessionDetailCache: trimSessionDetailCache(
      {
        ...s.sessionDetailCache,
        // Profile responses do not make an unfinished transcript fresh.
        [sessionId]: { ...existing, ...patch },
      },
      s.selectedSessionId,
    ),
  }));
}

function ensureLiveStream(sessionId: string): void {
  if (useAgentSessionStore.getState().selectedSessionId !== sessionId) return;
  ensureSessionLiveSubscription(sessionId, (event) => {
    useAgentSessionStore.getState().applyLiveEvent(event, sessionId);
  });
}

// One trailing refresh across the global bus, session stream, Dock and usage
// events. Mutations still use immediate refreshDetail when their caller needs it.
let liveDetailRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRefresh: {
  projectId: string | null;
  list: boolean;
  detail: string | null;
  usage: string | null;
  interactions: string | null;
} | null = null;
let sessionDetailsVisible = true;
const refreshRevisions = new Map<string, number>();

export function clearScheduledSessionRefresh(): void {
  if (liveDetailRefreshTimer) clearTimeout(liveDetailRefreshTimer);
  liveDetailRefreshTimer = null;
  pendingRefresh = null;
  refreshRevisions.clear();
}
export function setSessionDetailsVisible(visible: boolean): void {
  sessionDetailsVisible = visible;
  if (pendingRefresh && !liveDetailRefreshTimer && !document.hidden)
    liveDetailRefreshTimer = setTimeout(flushScheduledSessionRefresh, 0);
}
function flushScheduledSessionRefresh(): void {
  liveDetailRefreshTimer = null;
  const pending = pendingRefresh,
    state = useAgentSessionStore.getState();
  if (!pending) return;
  if (pending.projectId !== state.projectId) {
    pendingRefresh = null;
    return;
  }
  if (typeof document !== "undefined" && document.hidden) return;
  if (pending.list) {
    pending.list = false;
    void state.refreshSessions({ joinPending: true });
  }
  if (!sessionDetailsVisible) return;
  pendingRefresh = null;
  if (pending.detail && pending.detail === state.selectedSessionId)
    void state.refreshDetail({ background: true });
  else if (pending.usage && pending.usage === state.selectedSessionId &&
    (visibleProfiles.has(pending.usage) || !state.sessions.find((session) => session.id === pending.usage)?.sessionMetadata?.historyStorage))
    void state.fetchSessionInvocationUsage();
  if (pending.interactions && pending.interactions === state.selectedSessionId)
    void state.refreshInteractions(pending.interactions);
}
export function scheduleSessionRefresh(
  sessionId: string | null,
  target: "all" | "list" | "detail" | "usage" | "interactions" = "all",
  revision?: number,
): void {
  const state = useAgentSessionStore.getState();
  if (Number.isSafeInteger(revision) && sessionId) {
    const key = `${state.projectId}:${sessionId}:${target}`;
    if ((refreshRevisions.get(key) ?? -1) >= revision!) return;
    refreshRevisions.set(key, revision!);
    if (refreshRevisions.size > 64)
      refreshRevisions.delete(refreshRevisions.keys().next().value!);
  }
  if (!pendingRefresh || pendingRefresh.projectId !== state.projectId)
    pendingRefresh = {
      projectId: state.projectId,
      list: false,
      detail: null,
      usage: null,
      interactions: null,
    };
  if (target === "all" || target === "list") pendingRefresh.list = true;
  if (sessionId && sessionId === state.selectedSessionId) {
    if (target === "all" || target === "detail")
      pendingRefresh.detail = sessionId;
    if (target === "usage") pendingRefresh.usage = sessionId;
    if (target === "interactions") pendingRefresh.interactions = sessionId;
  } else if (
    sessionId &&
    target !== "list" &&
    target !== "interactions" &&
    state.sessionDetailCache[sessionId]
  ) {
    const cached = state.sessionDetailCache[sessionId];
    useAgentSessionStore.setState({
      sessionDetailCache: {
        ...state.sessionDetailCache,
        [sessionId]: { ...cached, cachedAt: 0 },
      },
    });
  }
  if (!liveDetailRefreshTimer)
    // Usage and interactions reconcile visible state, so they ride the fast
    // tier; transcript-sized detail refreshes coalesce on the slower one.
    liveDetailRefreshTimer = setTimeout(
      flushScheduledSessionRefresh,
      target === "usage" || target === "interactions" ? 500 : 1200,
    );
}
function scheduleLiveRefreshDetail(target: "detail" | "usage" = "detail"): void {
  scheduleSessionRefresh(
    useAgentSessionStore.getState().selectedSessionId,
    target,
  );
}
function scheduleInvocationUsageRefresh(): void {
  scheduleSessionRefresh(
    useAgentSessionStore.getState().selectedSessionId,
    "usage",
  );
}
function clearInvocationUsageRefresh(): void {
  if (pendingRefresh) {
    pendingRefresh.usage = null;
    pendingRefresh.detail = null;
  }
}

function upsertById<T extends { id: string }>(items: T[], next: T, limit = Infinity): T[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    const appended = [...items, next];
    return appended.length > limit + 60 ? appended.slice(-limit) : appended;
  }
  if (items[index] === next) return items;
  const replaced = [...items];
  replaced[index] = next;
  return replaced;
}

/** A slow history response must not overwrite records delivered by the live stream meanwhile. */
function preserveLiveRecords<T extends { id: string }>(loaded: T[], before: T[], current: T[]): T[] {
  if (before === current) return loaded;
  const originals = new Map(before.map((item) => [item.id, item]));
  const merged = new Map(loaded.map((item) => [item.id, item]));
  for (const item of current) {
    if (originals.get(item.id) !== item) merged.set(item.id, item);
  }
  return [...merged.values()];
}

type RuntimeSnapshotEventPayload = Extract<
  SessionLiveEvent,
  { type: "runtime_snapshot" }
>;

/** Replay a reconnect snapshot into one local state transition. */
function projectRuntimeSnapshot(
  state: Pick<
    AgentSessionStoreState,
    "steps" | "toolCalls" | "streamingLive" | "streamingStepId" | "streamingRetry"
  >,
  event: RuntimeSnapshotEventPayload,
): Pick<
  AgentSessionStoreState,
  "steps" | "toolCalls" | "streamingLive" | "streamingStepId" | "streamingRetry"
> {
  let stepId: string | null = null;
  let streamingLive = EMPTY_STREAMING_BUFFERS;
  let streamingRetry: LlmRetryState | null = null;
  let steps = state.steps;
  let toolCalls = state.toolCalls;

  for (const chunk of event.liveChunks) {
    if (chunk.type === "step_started" && chunk.step) {
      stepId = chunk.step.id;
      steps = upsertById(steps, chunk.step);
      streamingLive = EMPTY_STREAMING_BUFFERS;
      streamingRetry = null;
      continue;
    }
    if (!stepId || chunk.stepId !== stepId) continue;

    if (chunk.type === "message_delta" && chunk.delta !== undefined) {
      streamingLive = applyMessageDelta(streamingLive, chunk.delta);
    } else if (chunk.type === "thought_delta" && chunk.delta !== undefined) {
      streamingLive = applyThoughtDelta(streamingLive, chunk.delta);
    } else if (chunk.type === "tool_call" && chunk.toolCall) {
      streamingLive = applyToolCall(streamingLive, chunk.toolCall);
      toolCalls = upsertById(toolCalls, chunk.toolCall);
    } else if (chunk.type === "tool_result" && chunk.toolCall) {
      streamingLive = applyToolResult(streamingLive, chunk.toolCall);
      toolCalls = upsertById(toolCalls, chunk.toolCall);
    } else if (chunk.type === "retry_status" && chunk.retry) {
      streamingRetry =
        chunk.retry.phase === "recovered" ? null : chunk.retry;
      if (chunk.retry.phase === "waiting" || chunk.retry.phase === "group_wait")
        streamingLive = EMPTY_STREAMING_BUFFERS;
    }
  }

  return {
    steps,
    toolCalls,
    streamingLive,
    streamingStepId: stepId,
    streamingRetry,
  };
}

// Batch token bursts at most once every 32 ms, preserving transport order.
// Flush the whole batch at step/tool boundaries so buffered text never moves
// behind a tool or disappears when a fast model starts its next step.
const STREAM_FLUSH_MS = 32;
let deltaBuffer: Array<{ type: "text" | "thinking"; delta: string }> = [];
let bufferedDeltaChars = 0;
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

function takeBufferedDeltas(): Array<{ type: "text" | "thinking"; delta: string }> {
  if (deltaFlushTimer !== null) clearTimeout(deltaFlushTimer);
  deltaFlushTimer = null;
  const pending = deltaBuffer;
  deltaBuffer = [];
  bufferedDeltaChars = 0;
  return pending;
}

function applyBufferedDeltas(
  streamingLive: StreamingLiveBuffers,
  pending: readonly { type: "text" | "thinking"; delta: string }[],
): StreamingLiveBuffers {
  let next = streamingLive;
  for (const item of pending) {
    next =
      item.type === "thinking"
        ? applyThoughtDelta(next, item.delta)
        : applyMessageDelta(next, item.delta);
  }
  return next;
}

function flushStreamingDeltas(): void {
  const pending = takeBufferedDeltas();
  if (pending.length === 0) return;
  useAgentSessionStore.setState((state) => ({
    streamingLive: applyBufferedDeltas(state.streamingLive, pending),
  }));
}

function bufferStreamingDelta(type: "text" | "thinking", delta: string): void {
  if (!delta) return;
  const firstText = type === "text" && !hasStreamingText(useAgentSessionStore.getState().streamingLive);
  bufferedDeltaChars += delta.length;
  const last = deltaBuffer[deltaBuffer.length - 1];
  if (last?.type === type) last.delta += delta;
  else deltaBuffer.push({ type, delta });
  if (firstText || bufferedDeltaChars >= 64 * 1024 || deltaBuffer.length >= 64) {
    flushStreamingDeltas();
    return;
  }
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
  /**
   * When the current workspace's list was last confirmed by the runtime.
   * `0` means this workspace has never loaded, so a switch stays lazy.
   */
  sessionListLoadedAt: number;
  sessionListLoading: boolean;
  sessionListError: string | null;
  detailLoading: boolean;
  /** A complete cached snapshot remains visible during a background refresh. */
  detailRefreshing: boolean;
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
  streamingCompletedSteps: CompletedLiveStep[];
  contextCompactionNotice: ContextCompactionNotice | null;

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
  /**
   * Paint a workspace's list the first time it is opened. Every later visit
   * reuses the remembered snapshot: the list is never reconciled on its own,
   * rows arrive through live callbacks, and explicit actions still call
   * `refreshSessions`.
   */
  ensureSessionsLoaded: () => Promise<void>;
  refreshSessions: (options?: { joinPending?: boolean }) => Promise<void>;
  /**
   * Read one session by id and paint its row.
   *
   * Live callbacks name the session they change but a row can be missing — a
   * session created in another window, or one outside the loaded page — and a
   * patch-less event carries no fields at all. Reading that one session keeps
   * the list honest without re-reading (and re-ordering) the whole page.
   */
  syncSessionSummary: (sessionId: string) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  resetSessionDetailForDraft: () => void;
  resetConversationHistory: (sessionId: string) => void;
  submitSessionDraft: (
    projectId: string,
    body: SessionInputBody,
  ) => Promise<AgentSession>;
  deleteSession: (sessionId: string, onViewArchive?: () => void) => Promise<string[]>;
  permanentlyDeleteSession: (sessionId: string) => Promise<string[]>;
  discardRemovedSessions: (
    sessionIds: string[],
    projectId: string | null,
  ) => void;
  openPanel: (sessionId: string, options?: { forceFresh?: boolean }) => void;
  /** Paint the persisted last-known-good transcript before its refresh lands. */
  paintPersistedDetail: (sessionId: string) => Promise<void>;
  closePanel: () => void;
  compactHistoryTail: () => void;
  loadOlderHistory: () => Promise<void>;
  loadTimelineIndex: () => Promise<void>;
  loadHistoryUntil: (entryId: string) => Promise<boolean>;
  refreshDetail: (options?: {
    joinPending?: boolean;
    forceFresh?: boolean;
    /** Live events own a loaded active transcript; background work only refreshes its profile. */
    background?: boolean;
  }) => Promise<void>;
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
    body: {
      permissionTier?: SynaxPermissionTier;
      permissionOverrides?: Partial<Record<"read" | "write" | "delete" | "shell" | "task", "allow" | "ask" | "deny">>;
    },
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
  /** Upsert server-persisted native task anchors/receipts into their owner's cache. */
  ingestConversationMessages: (sessionId: string, messages: AgentRuntimeMessage[]) => void;
  applyLiveEvent: (event: SessionLiveEvent, streamSessionId?: string) => void;
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
  | "contextCompactionNotice"
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
    contextCompactionNotice: null,
  };
}

function clearStreamingBuffers(): void {
  deltaBuffer = [];
  if (deltaFlushTimer !== null) clearTimeout(deltaFlushTimer);
  deltaFlushTimer = null;
}

function snapshotCurrentStep(
  state: AgentSessionStoreState,
): CompletedLiveStep[] {
  if (!state.streamingStepId || !hasStreamingContent(state.streamingLive))
    return state.streamingCompletedSteps;
  const step = state.steps.find((item) => item.id === state.streamingStepId);
  return [
    ...state.streamingCompletedSteps.filter(
      (item) => item.stepId !== state.streamingStepId,
    ),
    {
      stepId: state.streamingStepId,
      stepIndex: step?.index ?? state.streamingCompletedSteps.length + 1,
      startedAt: step?.startedAt,
      runId:
        step?.runId ??
        state.sessions.find((item) => item.id === state.selectedSessionId)
          ?.activeRunId ??
        undefined,
      blocks: snapshotStreamingBuffers(state.streamingLive),
    },
  ].slice(-8);
}

/**
 * Retire live snapshots whose content the refreshed transcript now shows.
 *
 * The row must disappear in the same commit that renders the persisted
 * message: keeping the snapshot until a later refresh copies the answer, and
 * dropping it before the message lands makes the answer blink out. Incremental
 * pages omit unchanged tool calls, so those are verified leniently.
 */
function retireSnapshots(
  snapshots: AgentSessionStoreState["streamingCompletedSteps"],
  steps: AgentRunStep[],
  messages: AgentRuntimeMessage[],
  toolCalls: ToolCallRecord[],
  incremental: boolean,
): AgentSessionStoreState["streamingCompletedSteps"] {
  return retirePersistedSnapshots(
    snapshots,
    steps,
    messages,
    incremental ? undefined : toolCalls,
  );
}

export const useAgentSessionStore = create<AgentSessionStoreState>(
  (set, get) => ({
    projectId: null,
    draftMode: "chat",
    interactionState: null,
    sessions: [],
    sessionListTotal: null,
    sessionListOffset: 0,
    sessionListLoadedAt: 0,
    sessionListLoading: false,
    sessionListError: null,
    detailLoading: false,
    detailRefreshing: false,
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
    contextCompactionNotice: null,
    inputQueues: {},

    setDraftMode: (draftMode) => set({ draftMode }),

    refreshInteractions: async (sessionId) => {
      if (get().selectedSessionId !== sessionId) return;
      // A removed or archived session owns no interactions; the fetch would
      // only come back as a NOT_FOUND for a session the user already saw go.
      if (isRuntimeResourceGone(sessionId)) return;
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
      if (body.action === "submit") {
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === sessionId && session.status === "waiting_input"
              ? { ...session, status: "running" }
              : session,
          ),
        }));
      }
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
      const previous = get();
      // Park the workspace being left so a return visit paints its list and its
      // last conversation instead of paying for the same reads again.
      if (previous.projectId) {
        rememberSessionList(previous.projectId, {
          sessions: previous.sessions,
          total: previous.sessionListTotal,
          offset: previous.sessionListOffset,
          loadedAt: previous.sessionListLoadedAt,
        });
        rememberInactiveProjectDetails(
          previous.projectId,
          previous.sessionDetailCache,
        );
      }
      clearFinalReplyRetry();
      clearScheduledSessionRefresh();
      activeSessionsRefresh = null;
      activeSessionsPage = null;
      activeDetailRefresh = null;
      activeTranscriptRefresh = null;
      clearInvocationUsageRefresh();
      ++detailRefreshEpoch;
      releaseSessionLiveSubscription();
      clearStreamingBuffers();
      const cached = recallSessionList(projectId);
      set({
        projectId,
        draftMode: "chat",
        sessions: cached?.sessions ?? [],
        sessionListTotal: cached?.total ?? null,
        sessionListOffset: cached?.offset ?? 0,
        sessionListLoadedAt: cached?.loadedAt ?? 0,
        sessionListLoading: false,
        sessionListError: null,
        detailLoading: false,
        detailError: null,
        readSessionMarkers: loadReadMarkers(projectId),
        sessionDetailCache: projectId
          ? trimSessionDetailCache(recallInactiveProjectDetails(projectId))
          : {},
        ...emptySessionDetailState(),
      });
      // A first visit loads right away; a remembered workspace paints and only
      // reconciles once its snapshot is stale, so switching back never blocks.
      void get().ensureSessionsLoaded();
    },

    ensureSessionsLoaded: async () => {
      const { projectId, sessionListLoadedAt } = get();
      if (!projectId) return;
      // One read per workspace per session: a failed first read leaves the
      // stamp at zero so the next mount retries.
      if (sessionListLoadedAt > 0) return;
      await get().refreshSessions({ joinPending: true });
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
                      (Number(session.sessionMetadata?.pinned === true) <
                        Number(
                          items[items.length - 1].sessionMetadata?.pinned ===
                            true,
                        ) ||
                        ((session.sessionMetadata?.pinned === true) ===
                          (items[items.length - 1].sessionMetadata?.pinned ===
                            true) &&
                          session.updatedAt <=
                            items[items.length - 1].updatedAt)))) &&
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
                sessionListLoadedAt: Date.now(),
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
            // Keep the remembered copy of this workspace current, so leaving it
            // now does not require a read on the way back.
            rememberCurrentSessionList(projectId);
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

    syncSessionSummary: async (sessionId) => {
      if (!sessionId || isRuntimeResourceGone(sessionId)) return;
      const targetProjectId = get().projectId;
      if (!targetProjectId) return;
      let session: AgentSession;
      try {
        ({ session } = await agentRuntimeApi.getSessionSummary(sessionId));
      } catch {
        // A callback about a session that is gone, or a transient read failure,
        // must not surface as a list error.
        return;
      }
      if (session.projectId !== get().projectId) {
        // Another workspace's row: keep its remembered copy current only.
        updateSessionListRows((row) => (row.id === session.id ? session : row));
        return;
      }
      set((state) => {
        const index = state.sessions.findIndex((item) => item.id === session.id);
        if (index === -1)
          return {
            sessions: [session, ...state.sessions],
            sessionListTotal:
              state.sessionListTotal === null
                ? null
                : state.sessionListTotal + 1,
          };
        const live = state.sessions[index];
        // A read must not overwrite a patch that landed later.
        if (live === session || live.updatedAt > session.updatedAt) return {};
        const sessions = [...state.sessions];
        sessions[index] = session;
        return { sessions };
      });
      const current = get().projectId;
      if (current) rememberCurrentSessionList(current);
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
          rememberCurrentSessionList(projectId);
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
      clearFinalReplyRetry();
      activeDetailRefresh = null;
      activeTranscriptRefresh = null;
      releaseSessionLiveSubscription();
      clearStreamingBuffers();
      set({
        panelOpen: false,
        detailLoading: false,
        detailRefreshing: false,
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
        contextCompactionNotice: null,
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
      const mode = body.mode ?? get().draftMode;
      if ((body.backendId && !["native", "codex"].includes(body.backendId)) || body.model?.split("/")[0].endsWith("-acp")) {
        throw new AppError(
          "This execution backend has been removed. Start a native Synax session.",
          { level: "business", code: "VALIDATION" },
        );
      }
      const payload = await agentRuntimeApi.createSession({
        projectId,
        backendId: body.backendId ?? "native",
        model: body.model ?? undefined,
        mediaGeneration: body.mediaGeneration,
        profileId: SYNAX_PROFILE_ID,
        prompt,
        reasoningEffort: body.reasoningEffort ?? undefined,
        skillIds: body.skillIds?.length ? body.skillIds : undefined,
        mcpServerIds: body.mcpServerIds?.length ? body.mcpServerIds : undefined,
        permissionTier: body.permissionTier,
        permissionOverrides: body.permissionOverrides,
        gitWorkspace: body.gitWorkspace,
        sessionMetadata: createSynaxSessionMetadata(mode, {
          source: "session-page",
          userPrompt: message,
          ...(body.mediaGeneration ? { mediaGeneration: body.mediaGeneration } : {}),
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

    deleteSession: async (sessionId, onViewArchive) => {
      const projectId = get().projectId;
      // Suppress this session's in-flight detail requests before the delete
      // lands. They cannot be cancelled once dispatched, so without this the
      // responses arrive as a burst of "resource not found" notifications.
      markRuntimeResourcePendingRemoval(sessionId);
      let deletedSessionIds: string[];
      let archiveBatchId: string | undefined;
      let parentId: string | null = null;
      try {
        ({ archivedSessionIds: deletedSessionIds, archiveBatchId, parentId } =
          await agentRuntimeApi.deleteSession(sessionId));
      } catch (err) {
        clearRuntimeResourcePendingRemoval(sessionId);
        if (!isMissingSession(err, sessionId)) throw err;
        deletedSessionIds = [sessionId];
      }
      get().discardRemovedSessions(deletedSessionIds, projectId);
      if (archiveBatchId) {
        const batchId = archiveBatchId;
        const zh = useShellStore.getState().preferences.locale === "zh";
        const expiresAt = Date.now() + 8000;
        let restoring = false;
        useNotificationStore.getState().push({
          type: "success",
          layout: "archive",
          message: zh ? "已归档会话" : "Archived chat",
          duration: 8000,
          actions: [
            ...(onViewArchive ? [{ label: zh ? "查看" : "View", onClick: onViewArchive }] : []),
            {
              label: zh ? "撤销" : "Undo",
              variant: "primary",
              onClick: () => {
                if (restoring || Date.now() >= expiresAt) return;
                restoring = true;
                void (async () => {
                  try {
                    const result = await agentRuntimeApi.restoreSessionArchive(batchId);
                    markRuntimeResourcesRestored(result.restoredSessionIds);
                    await get().refreshSessions();
                    if (parentId && get().projectId === projectId) {
                      await get().fetchChildSessions(parentId);
                    }
                  } catch (err) {
                    useNotificationStore.getState().push({
                      type: "error",
                      message: zh ? "恢复会话失败，请前往会话归档重试" : "Failed to restore session. Please retry in Session Archive.",
                    });
                  }
                })();
              },
            },
          ],
        });
      }
      return deletedSessionIds;
    },

    permanentlyDeleteSession: async (sessionId) => {
      const projectId = get().projectId;
      markRuntimeResourcePendingRemoval(sessionId);
      try {
        const { deletedSessionIds } = await agentRuntimeApi.permanentlyDeleteSession(sessionId);
        get().discardRemovedSessions(deletedSessionIds, projectId);
        return deletedSessionIds;
      } catch (error) {
        clearRuntimeResourcePendingRemoval(sessionId);
        if (!isMissingSession(error, sessionId)) throw error;
        get().discardRemovedSessions([sessionId], projectId);
        return [sessionId];
      }
    },

    discardRemovedSessions: (deletedSessionIds, projectId) => {
      markRuntimeResourcesRemoved(deletedSessionIds);
      // A deleted or archived row must not repaint from disk on the next start.
      scheduleDeletePersistedDetail(deletedSessionIds);
      // Workspaces the user is not inside keep their own snapshot; drop the
      // removed rows there too so a return visit cannot show them again.
      forgetSessionsFromLists(deletedSessionIds);
      forgetSessionsFromInactiveDetails(deletedSessionIds);
      const deleted = new Set(deletedSessionIds);
      for (const id of deleted) profileFetchedAt.delete(id);
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
      terminalHistoryErrors.delete(sessionId);
      // The runtime just rewrote this transcript; the persisted page is now a
      // different conversation and must not be painted again.
      scheduleDeletePersistedDetail([sessionId]);
      const selected = get().selectedSessionId === sessionId;
      const alreadyRefreshing =
        activeDetailRefresh?.sessionId === sessionId ||
        activeTranscriptRefresh?.sessionId === sessionId;
      const existingCache = get().sessionDetailCache[sessionId];
      // The history mutation itself and its SSE confirmation can arrive back
      // to back. Keep one refresh transaction so a reconnect cannot clear the
      // transcript twice or start two competing snapshot hydrations.
      if (alreadyRefreshing && existingCache?.cachedAt === 0) return;
      if (selected) clearFinalReplyRetry();
      ++detailRefreshEpoch;
      activeDetailRefresh = null;
      activeTranscriptRefresh = null;
      if (selected) {
        releaseSessionLiveSubscription();
        clearStreamingBuffers();
      }
      set((state) => {
        const cache = { ...state.sessionDetailCache };
        const previous = cache[sessionId];
        if (previous) {
          cache[sessionId] = {
            ...previous,
            cachedAt: 0,
            historyPagesLoaded: false,
            timelineIndexLoaded: false,
          };
        }
        return {
          sessionDetailCache: cache,
          inputQueues: { ...state.inputQueues, [sessionId]: [] },
          ...(selected
            ? {
                // Keep the last complete transcript painted while the new
                // history root is fetched. The refresh flag communicates that
                // it is being replaced without flashing an empty skeleton.
                detailLoading: false,
                detailRefreshing: true,
                detailError: null,
                streamingRetry: null,
                streamingStepId: null,
                streamingLive: EMPTY_STREAMING_BUFFERS,
                streamingCompletedSteps: [],
                interactionState: null,
                contextCompactionNotice: null,
              }
            : {}),
        };
      });
      if (selected) ensureLiveStream(sessionId);
      void get().refreshDetail();
    },

    openPanel: (sessionId, options) => {
      if (isRuntimeResourceGone(sessionId)) return;
      const { panelOpen, selectedSessionId: prev } = get();
      const session = get().sessions.find((s) => s.id === sessionId);
      const liveSession = isActiveSessionStatus(session?.status);
      const forceFresh = options?.forceFresh === true;
      const existingCache = get().sessionDetailCache[sessionId];
      // A copy saved mid-run cannot answer for a session that has since settled;
      // a copy saved after completion is the finished transcript, so reopening
      // it inside the trust window costs nothing.
      const needsTailUpgrade = existingCache?.historyWindow?.generation !== undefined &&
        existingCache.historyWindow.hasEarlier && (existingCache.historyWindow.messageLimit ?? 0) < SESSION_TAIL_RETAIN &&
        existingCache.messages.length < SESSION_TAIL_RETAIN;
      const cacheFresh = !needsTailUpgrade && (
        existingCache?.restored === "active"
          ? false
          : existingCache?.restored === "terminal"
            ? isFreshInactivePageCache(
                existingCache,
                RESTORED_TERMINAL_TRUST_MS,
              )
            : isFreshInactivePageCache(existingCache));
      if (panelOpen && prev === sessionId) {
        if (!forceFresh && !liveSession && cacheFresh) return;
        if (
          forceFresh &&
          (activeDetailRefresh?.sessionId === sessionId ||
            activeTranscriptRefresh?.sessionId === sessionId)
        ) {
          return;
        }
      }

      const isSwitch = prev !== sessionId;
      if (isSwitch || forceFresh) {
        clearFinalReplyRetry();
        ++detailRefreshEpoch;
        clearInvocationUsageRefresh();
        activeDetailRefresh = null;
        activeTranscriptRefresh = null;
      }
      get().markSessionRead(sessionId);
      // Paint the last complete page immediately, including active sessions.
      // Live events and the change cursor reconcile it in the background.
      const cached = existingCache;
      // refreshDetail restores the persisted window before choosing its sync
      // cursor, avoiding a simultaneous uncursored history request on restart.
      const needsRefresh =
        forceFresh ||
        !cacheFresh ||
        isActiveSessionStatus(session?.status);
      set((state) => ({
        panelOpen: true,
        detailLoading: !cached?.cachedAt,
        detailRefreshing: needsRefresh && Boolean(cached?.cachedAt),
        detailError: null,
        selectedSessionId: sessionId,
        sessionDetailCache: trimSessionDetailCache(cached
          ? { ...state.sessionDetailCache, [sessionId]: { ...cached, lastVisitedAt: Date.now() } }
          : state.sessionDetailCache, sessionId),
        ...(isSwitch ? { interactionState: null } : {}),
        ...(isSwitch
          ? {
              streamingRetry: null,
              streamingStepId: null,
              streamingLive: EMPTY_STREAMING_BUFFERS,
              streamingCompletedSteps: [],
              contextCompactionNotice: null,
            }
          : {}),
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
          : isSwitch || forceFresh
            ? emptyDetailPayload()
            : {}),
      }));
      if (isSwitch || forceFresh) clearStreamingBuffers();
      if (isActiveSessionStatus(session?.status)) {
        ensureLiveStream(sessionId);
      } else if (isSwitch) {
        // Selection moved synchronously, but the live-subscription singleton
        // still belongs to the previous session until its owning effect
        // releases it. Drop it now: a stale stream must never render into the
        // newly selected (inactive) session's transcript slot.
        releaseSessionLiveSubscription();
      }
      if (isActiveSessionStatus(session?.status) || session?.status === "queued" || session?.status === "paused") {
        void get().loadInputQueue(sessionId);
      }

      // Completed/failed/cancelled pages are immutable from the transcript
      // perspective for a short TTL. Reuse their cached payload immediately,
      // then refresh stale pages in the background; runtime mutations still
      // invalidate them immediately. Active pages keep polling/live updates.
      if (needsRefresh) {
        void get().refreshDetail({
          joinPending: true,
          forceFresh,
        });
      }
    },

    closePanel: () => {
      releaseSessionLiveSubscription();
      clearInvocationUsageRefresh();
      clearFinalReplyRetry();
      set({ panelOpen: false });
    },

    paintPersistedDetail: async (sessionId) => {
      if (get().sessionDetailCache[sessionId]?.cachedAt) return;
      const projectId = get().projectId;
      const entry = await readPersistedDetail(sessionId, projectId);
      if (!entry || get().projectId !== projectId) return;
      // A refresh (or a switch back) may have produced a fresher entry while the
      // read was in flight; never let the disk copy win that race.
      if (get().sessionDetailCache[sessionId]?.cachedAt) return;
      const selected = get().selectedSessionId === sessionId;
      const painted = { ...entry };
      set((state) => ({
        sessionDetailCache: trimSessionDetailCache(
          {
            ...state.sessionDetailCache,
            [sessionId]: selected
              ? {
                  ...painted,
                  sessionStats: entry.sessionStats ?? state.sessionStats,
                  sessionTodos: entry.sessionTodos ?? state.sessionTodos,
                  sessionInvocationUsage:
                    entry.sessionInvocationUsage ??
                    state.sessionInvocationUsage,
                }
              : painted,
          },
          state.selectedSessionId,
        ),
        ...(selected
          ? {
              detailLoading: false,
              runs: entry.runs,
              steps: entry.steps,
              events: entry.events,
              messages: entry.messages,
              toolCalls: entry.toolCalls,
              permissions: entry.permissions,
              sessionStats: entry.sessionStats,
              sessionTodos: entry.sessionTodos,
              sessionInvocationUsage: entry.sessionInvocationUsage,
            }
          : {}),
      }));
    },

    compactHistoryTail: () => {
      const state = get();
      const id = state.selectedSessionId;
      if (!id || isSessionHistoryReading(id)) return;
      const current = state.sessionDetailCache[id];
      if (!current) return;
      const entry = compactSessionTail(current);
      if (entry === current) return;
      set({ messages: entry.messages, runs: entry.runs, steps: entry.steps,
        toolCalls: entry.toolCalls, events: entry.events, permissions: entry.permissions,
        sessionDetailCache: { ...state.sessionDetailCache, [id]: entry } });
    },
    loadOlderHistory: async () => {
      const sessionId = get().selectedSessionId;
      if (!sessionId) return;
      const initial = get().sessionDetailCache[sessionId];
      const cursor = initial?.historyWindow?.olderCursor;
      if (activeOlderHistory?.sessionId === sessionId)
        return activeOlderHistory.promise;
      if (!cursor) return;
      const promise = (async () => {
        let pages;
        let rebuilt = false;
        try {
          pages = [await agentRuntimeApi.historyWindow(sessionId, cursor)];
        } catch (error) {
          if ((error as { code?: string }).code !== "HISTORY_STALE")
            throw error;
          // Cursors are tied to an immutable tree root. If new messages have
          // arrived, walk the new root until we rejoin the oldest loaded row.
          const oldestId = initial.messages[0]?.id;
          let latest = await agentRuntimeApi.historyWindow(sessionId);
          if (latest.historyWindow.epoch !== initial.historyWindow?.epoch) {
            await get().refreshDetail();
            return;
          }
          pages = [latest];
          rebuilt = true;
          while (
            latest.historyWindow.olderCursor &&
            (!oldestId ||
              !latest.messages.some((message) => message.id === oldestId))
          ) {
            latest = await agentRuntimeApi.historyWindow(
              sessionId,
              latest.historyWindow.olderCursor,
            );
            pages.push(latest);
          }
          if (latest.historyWindow.olderCursor) {
            pages.push(
              await agentRuntimeApi.historyWindow(
                sessionId,
                latest.historyWindow.olderCursor,
              ),
            );
          }
        }
        if (get().selectedSessionId !== sessionId) return;
        pages = await Promise.all(
          pages.map(async (page) => ({
            ...page,
            messages: await hydrateHistoryMessageContent(
              sessionId,
              page.messages,
              page.historyWindow.revision,
            ),
          })),
        );
        if (get().selectedSessionId !== sessionId) return;
        set((state) => {
          const current = state.sessionDetailCache[sessionId];
          if (
            !current?.historyWindow ||
            current.historyWindow.epoch !== pages[0].historyWindow.epoch ||
            (!rebuilt && current.historyWindow.olderCursor !== cursor)
          )
            return state;
          const base: SessionDetailCacheEntry = rebuilt
            ? {
                ...pages[0],
                sessionStats: current.sessionStats,
                sessionTodos: current.sessionTodos,
                sessionInvocationUsage: current.sessionInvocationUsage,
                cachedAt: Date.now(),
              }
            : current;
          const entry = (rebuilt ? pages.slice(1) : pages).reduce(
            prependHistory,
            base,
          );
          return {
            messages: entry.messages,
            runs: entry.runs,
            steps: entry.steps,
            toolCalls: entry.toolCalls,
            events: entry.events,
            permissions: entry.permissions,
            sessionDetailCache: trimSessionDetailCache(
              {
                ...state.sessionDetailCache,
                [sessionId]: entry,
              },
              state.selectedSessionId,
            ),
          };
        });
        schedulePersistDetail(
          sessionId,
          get().projectId,
          get().sessionDetailCache[sessionId],
          isActiveSessionStatus(
            get().sessions.find((session) => session.id === sessionId)?.status,
          )
            ? "active"
            : "terminal",
        );
      })();
      activeOlderHistory = { sessionId, promise };
      try {
        await promise;
      } finally {
        if (activeOlderHistory?.promise === promise) activeOlderHistory = null;
      }
    },
    loadTimelineIndex: async () => {
      const sessionId = get().selectedSessionId;
      if (!sessionId) return;
      if (activeTimelineIndex?.sessionId === sessionId)
        return activeTimelineIndex.promise;
      const initial = get().sessionDetailCache[sessionId];
      if (!initial?.historyWindow || initial.timelineIndexLoaded) return;
      if (!initial.historyWindow.olderCursor) {
        set((state) => {
          const current = state.sessionDetailCache[sessionId];
          if (
            !current ||
            state.selectedSessionId !== sessionId ||
            current.historyWindow?.hasEarlier
          )
            return state;
          return {
            sessionDetailCache: {
              ...state.sessionDetailCache,
              [sessionId]: {
                ...current,
                timelineIndexLoaded: true,
                timelineIndexError: undefined,
              },
            },
          };
        });
        return;
      }
      const promise = (async () => {
        let cursor = initial.historyWindow!.olderCursor;
        let revision = initial.historyWindow!.revision;
        let epoch = initial.historyWindow!.epoch;
        let restarts = 0;
        let timelineMessages =
          initial.timelineMessages ??
          initial.messages.map(previewTimelineMessage);
        let timelineRuns = initial.timelineRuns ?? initial.runs;
        let timelineSteps = initial.timelineSteps ?? initial.steps;
        let timelineToolCalls = initial.timelineToolCalls ?? initial.toolCalls;
        try {

          while (cursor && get().selectedSessionId === sessionId) {
            let older: HistoryWindowResponse;
            try {
              older = initial.historyWindow?.generation !== undefined
                ? await agentRuntimeApi.historyIndexPage(sessionId, cursor)
                : await agentRuntimeApi.historyWindow(sessionId, cursor);
            } catch (error) {
              if (
                (error as { code?: string }).code !== "HISTORY_STALE" ||
                ++restarts > 2
              )
                throw error;
              // Rebase the rail only. Never replace the reader's visible page.
              const latest = await readLatestHistoryWindow(sessionId);
              if (get().selectedSessionId !== sessionId) return;
              revision = latest.historyWindow.revision;
              epoch = latest.historyWindow.epoch;
              cursor = latest.historyWindow.olderCursor;
              const seed = seedTimelineIndex(latest);
              timelineMessages = seed.timelineMessages ?? [];
              timelineRuns = seed.timelineRuns ?? [];
              timelineSteps = seed.timelineSteps ?? [];
              timelineToolCalls = seed.timelineToolCalls ?? [];
              continue;
            }
            if (get().selectedSessionId !== sessionId) return;
            if (
              (initial.historyWindow?.generation === undefined && older.historyWindow.revision !== revision) ||
              older.historyWindow.epoch !== epoch
            ) {
              if (++restarts > 2) return;
              const latest = await readLatestHistoryWindow(sessionId);
              revision = latest.historyWindow.revision;
              epoch = latest.historyWindow.epoch;
              cursor = latest.historyWindow.olderCursor;
              const seed = seedTimelineIndex(latest);
              timelineMessages = seed.timelineMessages ?? [];
              timelineRuns = seed.timelineRuns ?? [];
              timelineSteps = seed.timelineSteps ?? [];
              timelineToolCalls = seed.timelineToolCalls ?? [];
              continue;
            }
            const nextCursor = older.historyWindow.olderCursor;
            if (nextCursor === cursor)
              throw new Error("History cursor did not advance");
            const indexed = extendTimelineIndex(
              {
                ...initial,
                timelineMessages,
                timelineRuns,
                timelineSteps,
                timelineToolCalls,
              },
              older,
            );
            timelineMessages = indexed.timelineMessages ?? timelineMessages;
            timelineRuns = indexed.timelineRuns ?? timelineRuns;
            timelineSteps = indexed.timelineSteps ?? timelineSteps;
            timelineToolCalls = indexed.timelineToolCalls ?? timelineToolCalls;
            cursor = nextCursor;
            // Publish rail previews page by page; the visible transcript stays put.
            set((state) => {
              const current = state.sessionDetailCache[sessionId];
              if (!current || state.selectedSessionId !== sessionId || current.historyWindow?.epoch !== epoch) return state;
              return { sessionDetailCache: { ...state.sessionDetailCache, [sessionId]: {
                ...current, ...extendTimelineIndex(current, {messages:timelineMessages,runs:timelineRuns,steps:timelineSteps,toolCalls:timelineToolCalls,events:[],permissions:[],historyWindow:current.historyWindow!}),
                timelineIndexLoaded: !cursor, timelineIndexError: undefined,
              } } };
            });
          }
          if (get().selectedSessionId !== sessionId) return;
          set((state) => {
            const current = state.sessionDetailCache[sessionId];
            if (
              !current ||
              state.selectedSessionId !== sessionId ||
              current.historyWindow?.epoch !== epoch ||
              (initial.historyWindow?.generation === undefined && current.historyWindow?.revision !== revision)
            )
              return state;
            return {
              sessionDetailCache: {
                ...state.sessionDetailCache,
                [sessionId]: {
                  ...current,
                  ...extendTimelineIndex(current, {messages:timelineMessages,runs:timelineRuns,steps:timelineSteps,toolCalls:timelineToolCalls,events:[],permissions:[],historyWindow:current.historyWindow!}),
                  timelineIndexLoaded: true,
                  timelineIndexError: undefined,
                },
              },
            };
          });
        } catch (error) {
          set((state) => {
            const current = state.sessionDetailCache[sessionId];
            if (!current || state.selectedSessionId !== sessionId) return state;
            return {
              sessionDetailCache: {
                ...state.sessionDetailCache,
                [sessionId]: {
                  ...current,
                  timelineIndexError: String(error),
                },
              },
            };
          });
        }
      })();
      activeTimelineIndex = { sessionId, promise };
      try {
        await promise;
      } finally {
        if (activeTimelineIndex?.promise === promise)
          activeTimelineIndex = null;
        const current = get().sessionDetailCache[sessionId];
        if (
          get().selectedSessionId === sessionId &&
          current?.historyWindow &&
          !current.timelineIndexLoaded &&
          !current.timelineIndexError &&
          (current.historyWindow.revision !== initial.historyWindow.revision ||
            current.historyWindow.epoch !== initial.historyWindow.epoch)
        ) {
          void get().loadTimelineIndex();
        }
      }
    },
    loadHistoryUntil: async (entryId) => {
      const sessionId = get().selectedSessionId;
      if (!sessionId) return false;
      while (get().selectedSessionId === sessionId) {
        const current = get().sessionDetailCache[sessionId];
        if (!current) return false;
        if (
          timelineContainsEntry(current, entryId) ||
          (entryId === `user-input-${sessionId}` &&
            !current.historyWindow?.hasEarlier)
        )
          return true;
        const cursor = current.historyWindow?.olderCursor;
        if (!cursor) return false;
        await get().loadOlderHistory();
        if (
          get().sessionDetailCache[sessionId]?.historyWindow?.olderCursor ===
            cursor &&
          !activeOlderHistory?.promise
        )
          return false;
      }
      return false;
    },
    /**
     * Refresh the selected session's detail.
     *
     * Profile-critical data (stats, todos, invocation usage) is applied as
     * soon as each response lands, and the heavier transcript queries (events,
     * messages, tool calls) are applied in the background.
     */
    refreshDetail: async (options) => {
      const targetSessionId = get().selectedSessionId;
      const targetProjectId = get().projectId;
      const forceFresh = options?.forceFresh === true;
      if (!targetSessionId) return;
      if (forceFresh) terminalHistoryErrors.delete(targetSessionId);
      else if (terminalHistoryErrors.has(targetSessionId)) {
        set({ detailLoading: false, detailRefreshing: false, detailError: terminalHistoryErrors.get(targetSessionId)! });
        return;
      }
      // A deleted session has nothing left to refresh; without this every poll
      // tick would re-issue the full nine-request burst against a dead id.
      if (isRuntimeResourceGone(targetSessionId)) return;

      // A terminal patch can arrive while an older transcript request is in
      // flight. Freeze the last delta before any result is allowed to settle.
      const status = get().sessions.find(
        (item) => item.id === targetSessionId,
      )?.status;
      if (isTerminalSessionStatus(status) && get().streamingStepId) {
        flushStreamingDeltas();
        set((state) => ({
          streamingCompletedSteps: snapshotCurrentStep(state),
          streamingStepId: null,
          streamingLive: EMPTY_STREAMING_BUFFERS,
          streamingRetry: null,
        }));
        clearStreamingBuffers();
      }

      if (activeDetailRefresh?.sessionId === targetSessionId) {
        if (!options?.joinPending && (!options?.background || !isActiveSessionStatus(status)))
          activeDetailRefresh.again = true;
        return activeDetailRefresh.promise;
      }

      if (
        (options?.joinPending || (options?.background && isActiveSessionStatus(status))) &&
        activeTranscriptRefresh?.sessionId === targetSessionId
      )
        return activeTranscriptRefresh.promise;
      const hasReadyCache = Boolean(
        get().sessionDetailCache[targetSessionId]?.cachedAt,
      );
      const hasVisibleDetail =
        get().selectedSessionId === targetSessionId &&
        (get().messages.length > 0 ||
          get().steps.length > 0 ||
          get().runs.length > 0);
      set({
        // A history rewrite invalidates the cache but should keep the last
        // complete transcript painted until the replacement arrives.
        detailLoading: !hasReadyCache && !hasVisibleDetail,
        detailRefreshing: true,
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
            if (!forceFresh && !get().sessionDetailCache[targetSessionId]?.cachedAt) {
              await get().paintPersistedDetail(targetSessionId);
              if (refresh.again) continue;
              if (!isCurrent()) return;
            }
            if (!get().sessions.some((session) => session.id === targetSessionId)) {
              const { session } = await agentRuntimeApi.getSessionSummary(targetSessionId);
              if (refresh.again) continue;
              if (!isCurrent() || session.projectId !== targetProjectId) return;
              set((state) => ({ sessions: [...state.sessions.filter((item) => item.id !== session.id), session] }));
              if (isActiveSessionStatus(session.status) || session.status === "queued" || session.status === "paused") {
                void get().loadInputQueue(targetSessionId);
              }
            }
            const cachedEntry =
              forceFresh
                ? undefined
                : get().sessionDetailCache[targetSessionId];
            const versioned =
              get().sessions.find((session) => session.id === targetSessionId)
                ?.sessionMetadata?.historyStorage;
            const windowed = Boolean(versioned);
            const knownEventId =
              !windowed && cachedEntry?.events?.length
                ? cachedEntry.events[cachedEntry.events.length - 1].id
                : undefined;

            const discardIfMissing = (error: unknown) => {
              if (!isCurrent() || !isMissingSession(error, targetSessionId))
                return false;
              get().discardRemovedSessions([targetSessionId], targetProjectId);
              return true;
            };
            // A versioned transcript opens with one window and its sync cursor.
            // Aggregate queries are requested by the expanded profile panel.
            // Legacy sessions retain their existing bounded refresh cadence.
            const profileFresh =
              windowed || (!forceFresh &&
              Date.now() - (profileFetchedAt.get(targetSessionId) ?? 0) <
                PROFILE_REFRESH_MS);
            // A failed read must retry on the next tick instead of being
            // remembered as a fresh window.
            let profileFailed = false;
            const profileUpdates = [
              profileFresh ? Promise.resolve() : agentRuntimeApi
                .getSessionStats(targetSessionId)
                .then((stats) => {
                  if (!isCurrent()) return;
                  set({ sessionStats: stats });
                  if (
                    !isActiveSessionStatus(
                      get().sessions.find(
                        (session) => session.id === targetSessionId,
                      )?.status,
                    )
                  ) {
                    patchSessionDetailCache(targetSessionId, {
                      sessionStats: stats,
                    });
                  }
                })
                .catch(() => {
                  /* stats are optional */
                  profileFailed = true;
                }),
              profileFresh ? Promise.resolve() : agentRuntimeApi
                .getSessionTodos(targetSessionId)
                .then((todosRes) => {
                  if (!isCurrent()) return;
                  set({ sessionTodos: todosRes.items });
                  if (
                    !isActiveSessionStatus(
                      get().sessions.find(
                        (session) => session.id === targetSessionId,
                      )?.status,
                    )
                  ) {
                    patchSessionDetailCache(targetSessionId, {
                      sessionTodos: todosRes.items,
                    });
                  }
                })
                .catch(() => {
                  /* todos are optional */
                  profileFailed = true;
                }),
              profileFresh ? Promise.resolve() : agentRuntimeApi
                .getSessionInvocationUsage(targetSessionId)
                .then((usage) => {
                  if (!isCurrent()) return;
                  set({ sessionInvocationUsage: usage });
                  if (
                    !isActiveSessionStatus(
                      get().sessions.find(
                        (session) => session.id === targetSessionId,
                      )?.status,
                    )
                  ) {
                    patchSessionDetailCache(targetSessionId, {
                      sessionInvocationUsage: usage,
                    });
                  }
                })
                .catch(() => {
                  /* retain the most recent successful usage snapshot */
                  profileFailed = true;
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
            if (options?.background && !forceFresh && sessionActive && cachedEntry?.cachedAt) {
              await Promise.all(profileUpdates);
              if (isCurrent() && !profileFresh && !profileFailed)
                profileFetchedAt.set(targetSessionId, Date.now());
              if (isCurrent()) set({ detailLoading: false, detailRefreshing: false });
              continue;
            }
            const toolCallsSource = windowed
              ? Promise.resolve({ items: [] })
              : sessionActive && cachedEntry?.cachedAt
                ? Promise.resolve({ items: get().toolCalls })
                : agentRuntimeApi.listToolCalls(targetSessionId);
            const transcriptTask = (async () => {
              let moreChanges = false;
              do {
                const beforeRead = get();
                const currentCache = get().sessionDetailCache[targetSessionId];
                const undersizedTail = currentCache?.historyWindow?.generation !== undefined &&
                  currentCache.historyWindow.hasEarlier && (currentCache.historyWindow.messageLimit ?? 0) < SESSION_TAIL_RETAIN &&
                  currentCache.messages.length < SESSION_TAIL_RETAIN;
                const since = (forceFresh || undersizedTail) && !moreChanges ? undefined : currentCache?.historyWindow?.syncCursor;
                const transcriptSource = windowed
                  ? readLatestHistoryWindow(targetSessionId,
                      since,
                    ).then(
                      (window) =>
                        [
                          { items: window.steps },
                          { items: window.runs },
                          { items: window.events },
                          {
                            items: window.messages,
                            historyWindow: window.historyWindow,
                            removed: window.removed,
                          },
                          { items: window.toolCalls },
                          { items: window.permissions },
                        ] as const,
                    )
                  : Promise.all([
                      // Steps and their messages must become visible together. A
                      // completed step alone would hide its still-visible live answer.
                      agentRuntimeApi.listSessionSteps(targetSessionId),
                      agentRuntimeApi.listRuns(targetSessionId),
                      agentRuntimeApi.listEvents(targetSessionId, knownEventId),
                      agentRuntimeApi.listMessages(targetSessionId),
                      toolCallsSource,
                      agentRuntimeApi.listPermissions(targetSessionId),
                    ]);
                await transcriptSource
                  .then(
                    async ([
                      stepsRes,
                      runsRes,
                      eventsRes,
                      messagesRes,
                      toolCallsRes,
                      permissionsRes,
                    ]) => {
                      if (!isCurrent()) return;
                      const hydratedMessages =
                        windowed && "historyWindow" in messagesRes
                          ? await hydrateHistoryMessageContent(
                              targetSessionId,
                              messagesRes.items,
                              messagesRes.historyWindow.revision,
                              cachedEntry?.messages,
                            )
                          : messagesRes.items;
                      if (!isCurrent()) return;
                      const events =
                        knownEventId && cachedEntry
                          ? [...cachedEntry.events, ...eventsRes.items].slice(-256)
                          : eventsRes.items;
                      moreChanges = "historyWindow" in messagesRes && messagesRes.historyWindow.hasMoreChanges === true;
                      if (moreChanges && "historyWindow" in messagesRes && (!messagesRes.historyWindow.syncCursor || messagesRes.historyWindow.syncCursor === since))
                        throw new AppError("History cursor did not advance.", {level: "business", code: "HISTORY_CURSOR_STALLED", statusCode: 422});
                      const cacheEntry: SessionDetailCacheEntry = {
                        runs: runsRes.items,
                        steps: stepsRes.items,
                        events,
                        messages: hydratedMessages,
                        toolCalls: toolCallsRes.items,
                        permissions: permissionsRes.items,
                        sessionStats: get().sessionStats,
                        sessionTodos: get().sessionTodos,
                        sessionInvocationUsage: get().sessionInvocationUsage,
                        cachedAt: Date.now(),
                        lastVisitedAt: Date.now(),
                        removed: "removed" in messagesRes ? messagesRes.removed : undefined,
                        historyWindow:
                          "historyWindow" in messagesRes
                            ? messagesRes.historyWindow
                            : undefined,
                        ...(windowed && "historyWindow" in messagesRes
                          ? {
                              ...seedTimelineIndex({
                                messages: hydratedMessages,
                                runs: runsRes.items,
                                steps: stepsRes.items,
                                toolCalls: toolCallsRes.items,
                                events: [],
                                permissions: [],
                                historyWindow: messagesRes.historyWindow,
                              }),
                              timelineIndexLoaded:
                                !messagesRes.historyWindow.olderCursor,
                            }
                          : {}),
                      };

                      let pendingFinalReply = false;
                      set((s) => {
                        let merged =
                          windowed && (!forceFresh || cacheEntry.historyWindow?.incremental)
                            ? mergeRefreshedHistory(
                                s.sessionDetailCache[targetSessionId],
                                cacheEntry,
                              )
                            : cacheEntry;
                        for (const collection of ["messages", "runs", "steps", "toolCalls", "events", "permissions"] as const) {
                          // Each collection retains its own entity type; the shared
                          // merge only compares identity and object references.
                          (merged[collection] as Array<{ id: string }>) = preserveLiveRecords<{ id: string }>(
                            merged[collection], beforeRead[collection], s[collection],
                          );
                        }
                        if (!isSessionHistoryReading(targetSessionId)) merged = compactSessionTail(merged);
                        // This response was reconciled against the runtime, so the
                        // entry no longer carries a restore-time provenance.
                        merged.restored = undefined;
                        const incremental = Boolean(cacheEntry.historyWindow?.incremental);
                        const currentStatus = s.sessions.find(
                          (item) => item.id === targetSessionId,
                        )?.status;
                        const terminal = isTerminalSessionStatus(currentStatus);
                        const snapshots = terminal
                          ? snapshotCurrentStep(s)
                          : s.streamingCompletedSteps;
                        // A snapshot without a run identity cannot recognise
                        // the persisted answer once its step leaves the warm
                        // `steps` page. Re-anchor them before deciding.
                        const anchored = attachSnapshotRunIds(
                          snapshots,
                          merged.steps,
                          merged.runs,
                          s.sessions.find((item) => item.id === targetSessionId)
                            ?.activeRunId,
                        );
                        const pendingSnapshots = retireSnapshots(
                          anchored,
                          merged.steps,
                          merged.messages,
                          merged.toolCalls,
                          incremental,
                        );
                        pendingFinalReply = terminal && pendingSnapshots.length > 0;
                        const preserveLive = isActiveSessionStatus(currentStatus);
                        return {
                          detailLoading: false,
                          detailRefreshing: false,
                          detailError: null,
                          runs: merged.runs,
                          steps: merged.steps,
                          events: merged.events,
                          contextCompactionNotice: contextCompactionNotice(
                            s.sessions.find((item) => item.id === targetSessionId)
                              ?.sessionMetadata?.contextCompaction as
                              | StoredContextCompaction
                              | undefined,
                          ),
                          messages: merged.messages,
                          toolCalls: merged.toolCalls,
                          permissions: merged.permissions,
                          sessionDetailCache: trimSessionDetailCache(
                            {
                              ...s.sessionDetailCache,
                              [targetSessionId]: merged,
                            },
                            s.selectedSessionId,
                          ),
                          streamingCompletedSteps: pendingSnapshots,
                          ...(preserveLive
                            ? {}
                            : {
                                streamingRetry: null,
                                streamingStepId: null,
                                streamingLive: EMPTY_STREAMING_BUFFERS,
                              }),
                        };
                      });

                      if (pendingFinalReply)
                        scheduleFinalReplyRetry(targetSessionId);
                      else clearFinalReplyRetry();

                      // A running session mutates on every chunk; its durable
                      // copy is written when the run settles or the reader
                      // leaves. Streaming a transcript to disk every poll would
                      // serialize megabytes for a page nobody will read cold.
                      schedulePersistDetail(
                        targetSessionId,
                        targetProjectId,
                        get().sessionDetailCache[targetSessionId],
                        isActiveSessionStatus(
                          get().sessions.find(
                            (session) => session.id === targetSessionId,
                          )?.status,
                        )
                          ? "active"
                          : "terminal",
                      );

                      const session = get().sessions.find(
                        (s) => s.id === targetSessionId,
                      );
                      if (session && session.childSessionIds.length > 0) {
                        void get().fetchChildSessions(targetSessionId);
                      }
                    },
                  );
              } while (moreChanges && isCurrent());
            })().catch((error) => {
                if (discardIfMissing(error)) return;
                if (isCurrent()) {
                  if (isPermanentHistoryError(error)) {
                    terminalHistoryErrors.set(targetSessionId, String(error));
                    if (terminalHistoryErrors.size > 64) terminalHistoryErrors.delete(terminalHistoryErrors.keys().next().value!);
                    clearFinalReplyRetry();
                  }
                  set({
                    detailLoading: false,
                    detailRefreshing: false,
                    detailError: String(error),
                  });
                  if (
                    !isPermanentHistoryError(error) && get().streamingCompletedSteps.length > 0 &&
                    isTerminalSessionStatus(
                      get().sessions.find(
                        (session) => session.id === targetSessionId,
                      )?.status,
                    )
                  )
                    scheduleFinalReplyRetry(targetSessionId);
                }
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
            if (isCurrent() && !profileFresh && !profileFailed)
              profileFetchedAt.set(targetSessionId, Date.now());
            // The transcript refresh keeps running without holding the poll loop.
            void transcriptTask;
          } catch (error) {
            if (get().selectedSessionId === targetSessionId && get().projectId === targetProjectId &&
              detailRefreshEpoch === epoch && !refresh.again) {
              if (isMissingSession(error, targetSessionId)) get().discardRemovedSessions([targetSessionId], targetProjectId);
              else set({ detailLoading: false, detailRefreshing: false, detailError: String(error) });
            }
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
            requestId,
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
          ["interrupted", "cancelled", "failed", "completed", "paused"].includes(
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

    ingestConversationMessages: (sessionId, incoming) => {
      const accepted = incoming.filter(message => message.sessionId === sessionId &&
        message.role === 'assistant' && ['git_merge_task', 'git_merge_receipt'].includes(String(message.metadata?.source)));
      if (!accepted.length) return;
      set(state => {
        const visible = state.selectedSessionId === sessionId;
        const cached = state.sessionDetailCache[sessionId];
        // A child response must never seed its cache with another transcript's rows.
        const base: SessionDetailCacheEntry = cached ?? {
          runs: [], steps: [], events: [], messages: [], toolCalls: [], permissions: [],
          sessionStats: null, sessionTodos: [], sessionInvocationUsage: null, cachedAt: 0,
        };
        const messages = accepted.reduce((items, message) => upsertById(items, message, Infinity), visible ? state.messages : base.messages);
        const entry = { ...base, messages,
          ...(base.timelineMessages ? { timelineMessages: accepted.reduce((items, message) => upsertById(items, previewTimelineMessage(message), Infinity), base.timelineMessages) } : {}),
        };
        return {
          ...(visible ? { messages, streamingCompletedSteps: retireSnapshots(state.streamingCompletedSteps, state.steps, messages, state.toolCalls, false) } : {}),
          sessionDetailCache: trimSessionDetailCache({ ...state.sessionDetailCache, [sessionId]: entry }, state.selectedSessionId),
        };
      });
    },

    applyLiveEvent: (event, streamSessionId) => {
      // Deltas, steps, retries and tool records carry no session id of their
      // own: they belong to the session whose live stream delivered them. The
      // subscription singleton can still be attached to a previous session
      // while selection already moved (its releasing effect runs later), so a
      // stale stream must never render into the newly selected transcript.
      const streamVisible =
        streamSessionId === undefined ||
        streamSessionId === get().selectedSessionId;
      switch (event.type) {
        case "conversation_git_messages": {
          if (streamSessionId) get().ingestConversationMessages(streamSessionId, event.messages);
          break;
        }
        case "execution_status": {
          if (!streamVisible || event.sessionId !== get().selectedSessionId) break;
          set(state => ({ runs: state.runs.map(run => run.id === event.runId && run.sessionId === event.sessionId
            ? { ...run, execution: event.execution } : run) }));
          break;
        }
        case "message": {
          if (!streamVisible || event.message.sessionId !== get().selectedSessionId) break;
          set((state) => {
            const messages = upsertById(state.messages, event.message, Infinity);
            const cached = state.sessionDetailCache[event.message.sessionId];
            const base = { ...cached,
              runs: state.runs, steps: state.steps, toolCalls: state.toolCalls,
              events: state.events, permissions: state.permissions, messages,
              sessionStats: state.sessionStats, sessionTodos: state.sessionTodos,
              sessionInvocationUsage: state.sessionInvocationUsage, cachedAt: cached?.cachedAt ?? 0,
              ...(cached?.timelineMessages ? {
                timelineMessages: upsertById(cached.timelineMessages, previewTimelineMessage(event.message), Infinity),
              } : {}),
            };
            const entry = isSessionHistoryReading(event.message.sessionId) ? base : compactSessionTail(base);
            return {
              messages: entry.messages, runs: entry.runs, steps: entry.steps,
              toolCalls: entry.toolCalls, events: entry.events, permissions: entry.permissions,
              sessionDetailCache: { ...state.sessionDetailCache, [event.message.sessionId]: entry },
              streamingCompletedSteps: retireSnapshots(
                state.streamingCompletedSteps, state.steps, messages, state.toolCalls, false,
              ),
            };
          });
          break;
        }
        case "event": {
          if (!streamVisible || event.event.sessionId !== get().selectedSessionId) break;
          set((state) => ({ events: upsertById(state.events, event.event, 256) }));
          patchSessionDetailCache(event.event.sessionId, { events: get().events });
          break;
        }
        case "permission_updated": {
          if (!streamVisible || event.permission.sessionId !== get().selectedSessionId) break;
          set((state) => ({ permissions: upsertById(state.permissions, event.permission) }));
          patchSessionDetailCache(event.permission.sessionId, { permissions: get().permissions });
          break;
        }
        case "input_queue_changed": {
          void get().loadInputQueue(event.sessionId);
          break;
        }
        case "runtime_snapshot": {
          if (!streamVisible || get().selectedSessionId !== event.sessionId)
            break;
          const next = projectRuntimeSnapshot(get(), event);
          const runtimeActive = [
            "running",
            "queued",
            "waiting_permission",
            "waiting_input",
          ].includes(event.session.status);
          clearStreamingBuffers();
          set((state) => {
            const index = state.sessions.findIndex(
              (session) => session.id === event.sessionId,
            );
            if (index < 0) return state;
            const sessions = [...state.sessions];
            sessions[index] = patchAgentSession(
              sessions[index],
              event.session,
            );
            return {
              sessions,
              ...(event.run?.sessionId === event.sessionId
                ? { runs: upsertById(state.runs, event.run) }
                : {}),
              steps: next.steps,
              toolCalls: next.toolCalls,
              streamingStepId: runtimeActive ? next.streamingStepId : null,
              streamingLive: runtimeActive
                ? next.streamingLive
                : EMPTY_STREAMING_BUFFERS,
              streamingRetry: runtimeActive ? next.streamingRetry : null,
            };
          });
          // The snapshot repairs the visible stream immediately. Reconcile
          // persisted messages and stats in the background without clearing the
          // just-hydrated turn again.
          // A live run already pushes its steps and messages; only the
          // lightweight counters need a background reconcile mid-run.
          scheduleLiveRefreshDetail(runtimeActive ? "usage" : "detail");
          break;
        }
        case "media_job":
          // Asset progress lands on the fast ring; rebuilding the whole
          // transcript for every media tick is what kept history hot.
          if (streamVisible) scheduleLiveRefreshDetail("usage");
          break;
        case "runtime_state": {
          get().patchSession(event.sessionId, event.patch);
          if (get().selectedSessionId !== event.sessionId) break;
          // Lifecycle chunks carry the authoritative run even when the latest
          // history page contains only messages. Do not leave the first send
          // tied to its queued POST receipt until the user reloads the chat.
          if (event.run?.sessionId === event.sessionId) {
            const run = event.run;
            set((state) => ({ runs: upsertById(state.runs, run) }));
          }
          const terminal = [
            "completed",
            "failed",
            "cancelled",
            "interrupted",
          ].includes(event.patch.status ?? "");
          if (event.reset) {
            if (terminal) {
              clearFinalReplyRetry();
              const pending = takeBufferedDeltas();
              set((state) => {
                const settled = {
                  ...state,
                  streamingLive: applyBufferedDeltas(
                    state.streamingLive,
                    pending,
                  ),
                };
                return {
                  streamingRetry: null,
                  streamingCompletedSteps: retireSnapshots(
                    snapshotCurrentStep(settled), state.steps, state.messages, state.toolCalls, false,
                  ),
                  streamingStepId: null,
                  streamingLive: EMPTY_STREAMING_BUFFERS,
                };
              });
            } else {
              clearFinalReplyRetry();
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
          if (terminal) scheduleInvocationUsageRefresh();
          break;
        }
        case "step_started": {
          if (!streamVisible) break;
          const pending = takeBufferedDeltas();
          set((state) => {
            const settled = {
              ...state,
              streamingLive: applyBufferedDeltas(
                state.streamingLive,
                pending,
              ),
            };
            const completedSteps = snapshotCurrentStep(settled);
            return {
              streamingRetry: null,
              streamingStepId: event.stepId,
              streamingLive: EMPTY_STREAMING_BUFFERS,
              streamingCompletedSteps: retireSnapshots(
                completedSteps, state.steps, state.messages, state.toolCalls, false,
              ).slice(-8),
              ...(event.step
                ? { steps: upsertById(state.steps, event.step) }
                : {}),
            };
          });
          break;
        }
        case "retry_status": {
          if (!streamVisible) break;
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
          if (!streamVisible) break;
          if (get().streamingStepId !== event.stepId) break;
          bufferStreamingDelta("text", event.delta);
          break;
        case "thought_delta":
          if (!streamVisible) break;
          if (get().streamingStepId !== event.stepId) break;
          bufferStreamingDelta("thinking", event.delta);
          break;
        case "tool_call": {
          if (!streamVisible) break;
          if (get().streamingStepId !== event.stepId) break;
          const isNewCall = !get().toolCalls.some(
            (call) => call.id === event.toolCall.id,
          );
          const pending = takeBufferedDeltas();
          set((s) => {
            const streamingLive = applyBufferedDeltas(
              s.streamingLive,
              pending,
            );
            return {
              streamingLive: applyToolCall(streamingLive, event.toolCall),
              toolCalls: upsertById(s.toolCalls, event.toolCall),
            };
          });
          if (isNewCall) scheduleInvocationUsageRefresh();
          break;
        }
        case "tool_result":
          if (!streamVisible) break;
          if (get().streamingStepId !== event.stepId) break;
          const pending = takeBufferedDeltas();
          set((s) => {
            const streamingLive = applyBufferedDeltas(
              s.streamingLive,
              pending,
            );
            return {
              streamingLive: applyToolResult(streamingLive, event.toolCall),
              toolCalls: upsertById(s.toolCalls, event.toolCall),
            };
          });
          break;
        case "context_compaction_state": {
          if (
            !streamVisible ||
            event.message.sessionId !== get().selectedSessionId
          )
            break;
          const session = get().sessions.find(
            (item) => item.id === event.message.sessionId,
          );
          get().patchSession(event.message.sessionId, {
            sessionMetadata: {
              ...session?.sessionMetadata,
              contextCompaction: event.state,
              ...(event.state.contextUsage
                ? { contextUsage: event.state.contextUsage }
                : {}),
            },
          });
          set((state) => ({
            contextCompactionNotice: contextCompactionNotice(event.state),
            messages: upsertById(state.messages, event.message),
          }));
          void get().fetchSessionStats();
          scheduleLiveRefreshDetail();
          break;
        }
        case "context_compaction_started":
          if (!streamVisible) break;
          set({ contextCompactionNotice: { status: "running" } });
          break;
        case "context_compacted":
          if (!streamVisible) break;
          if (event.contextUsage) {
            const session = get().sessions.find(
              (item) => item.id === get().selectedSessionId,
            );
            if (session) {
              get().patchSession(session.id, {
                sessionMetadata: {
                  ...session.sessionMetadata,
                  contextUsage: event.contextUsage,
                },
              });
            }
          }
          set({
            contextCompactionNotice: {
              status: "completed",
              originalTokens: event.originalTokens,
              compressedTokens: event.compressedTokens,
              messageCount: event.messageCount,
            },
          });
          void get().fetchSessionStats();
          scheduleLiveRefreshDetail();
          break;
        case "context_compaction_failed":
          if (!streamVisible) break;
          set({
            contextCompactionNotice: { status: "failed", error: event.error },
          });
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
      // A live patch can target a workspace the user is not inside. Keep its
      // remembered row current so a return visit shows the real status instead
      // of a stale one until the next reconcile.
      if (!patched)
        updateSessionListRows((session) =>
          session.id === sessionId
            ? patchAgentSession(session, patch)
            : session,
        );
      const terminal =
        patch.status === "completed" ||
        patch.status === "failed" ||
        patch.status === "cancelled" ||
        patch.status === "interrupted" ||
        patch.status === "paused";
      if (
        terminal &&
        get().selectedSessionId === sessionId &&
        get().panelOpen
      ) {
        get().markSessionRead(sessionId);
        // The run just settled. Live snapshots become eligible for retirement
        // as soon as the persisted answer arrives, so a stale snapshot can no
        // longer pin a copied answer to the end of the transcript.
        set((s) => {
          const pendingSnapshots = retireSnapshots(
            s.streamingCompletedSteps,
            s.steps,
            s.messages,
            s.toolCalls,
            false,
          );
          return pendingSnapshots === s.streamingCompletedSteps
            ? {}
            : { streamingCompletedSteps: pendingSnapshots };
        });
      }
      if (!patched && typeof patch.title === "string") {
        // An asynchronously generated title can land for a row this page never
        // loaded. Read that session instead of re-reading the whole list.
        void get().syncSessionSummary(sessionId);
      }
      return patched;
    },
  }),
);

/**
 * Drop every remembered trace of a workspace: its session list and the
 * transcripts parked while the user was elsewhere. Called when the workspace
 * itself is removed, so a re-used id cannot resurrect the old rows.
 */
export function forgetProjectSessionCache(projectId: string): void {
  forgetSessionList(projectId);
  forgetInactiveProjectDetails(projectId);
}

/** Test seam: drop every remembered workspace list and parked transcript. */
export function resetWorkspaceSessionCache(): void {
  resetSessionListCache();
  inactiveProjectDetails.clear();
}

// Live chunks mutate the cache entry outside any refresh transaction, so the
// moment the reader leaves a session is the cheapest point to make its
// transcript durable for the next process start.
useAgentSessionStore.subscribe((state, previous) => {
  const left = previous.selectedSessionId;
  if (!left || left === state.selectedSessionId) return;
  schedulePersistDetail(
    left,
    previous.projectId,
    previous.sessionDetailCache[left],
    isActiveSessionStatus(
      previous.sessions.find((session) => session.id === left)?.status,
    )
      ? "active"
      : "terminal",
  );
});
