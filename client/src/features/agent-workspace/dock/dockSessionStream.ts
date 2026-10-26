import type { RuntimeContentPart } from "../../../adapters/transport/runtimeMedia";
import {
  agentRuntimeApi,
  type PermissionDecision,
  type ReasoningEffort,
  type ToolCallRecord,
  type ToolCallStatus,
} from "../../../adapters/transport/agentRuntime";
import type { SessionLiveEvent } from "../../../adapters/transport/sessionLive";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useShellStore } from "../../../shared/state/shellStore";

export type DockSessionStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "waiting_input"
  | "completed"
  | "failed";

/** Checkpoints the runtime is parked on until a human answers. */
function isWaiting(status: DockSessionStatus): boolean {
  return status === "waiting_permission" || status === "waiting_input";
}

function hasOpenForm(sessionId: string | null): boolean {
  if (!sessionId) return false;
  const state = useAgentSessionStore.getState();
  return (
    state.interactionState?.sessionId === sessionId &&
    state.interactionState.items.some((item) => item.status === "pending")
  );
}

/** A run parked on a form stays parked: the status that resumes it only
 *  follows the reply. `waiting_input` alone can be stale after the answer, so
 *  the dock also asks whether a form is still open. */
function holdsAnsweredForm(session: DockSessionState): boolean {
  return session.status === "waiting_input" && hasOpenForm(session.sessionId);
}

export interface DockToolCall {
  id: string;
  tool: string;
  summary: string;
  outputSummary: string | null;
  status: ToolCallStatus;
}

export interface DockSessionState {
  status: DockSessionStatus;
  sessionId: string | null;
  title: string | null;
  promptFallback: string | null;
  toolCalls: DockToolCall[];
  permissions: PermissionDecision[];
  streamingThinking: string;
  streamingText: string;
  error: string | null;
}

export const initialDockSessionState: DockSessionState = {
  status: "idle",
  sessionId: null,
  title: null,
  promptFallback: null,
  toolCalls: [],
  permissions: [],
  streamingThinking: "",
  streamingText: "",
  error: null,
};

/** Placeholder titles only mean "not summarized yet"; prefer the user's input. */
const PLACEHOLDER_TITLES = ["new chat", "新对话"];

export function resolveDockSessionTitle(
  session: DockSessionState,
  workingLabel: string,
): string {
  const title = session.title?.trim();
  if (title && !PLACEHOLDER_TITLES.includes(title.toLowerCase())) return title;
  const fallback = session.promptFallback?.trim();
  if (fallback) return fallback;
  if (isDockSessionActive(session.status)) return workingLabel;
  return "";
}

type StreamChunk = {
  type?: string;
  delta?: string;
  toolCall?: ToolCallRecord;
  permission?: PermissionDecision;
  error?: string;
};

function toDockToolCall(toolCall: ToolCallRecord): DockToolCall {
  return {
    id: toolCall.id,
    tool: toolCall.toolId,
    summary: toolCall.inputSummary,
    outputSummary: toolCall.outputSummary,
    status: toolCall.status,
  };
}

function upsertToolCall(
  calls: DockToolCall[],
  toolCall: ToolCallRecord,
): DockToolCall[] {
  const next = toDockToolCall(toolCall);
  const index = calls.findIndex((call) => call.id === next.id);
  if (index === -1) return [...calls, next];
  const updated = [...calls];
  updated[index] = { ...updated[index], ...next };
  return updated;
}

function upsertPermission(
  permissions: PermissionDecision[],
  permission: PermissionDecision,
): PermissionDecision[] {
  const index = permissions.findIndex((item) => item.id === permission.id);
  if (index === -1) return [...permissions, permission];
  const updated = [...permissions];
  updated[index] = permission;
  return updated;
}

export function applyDockStreamChunk(
  state: DockSessionState,
  chunk: unknown,
): DockSessionState {
  if (!chunk || typeof chunk !== "object") return state;
  const typed = chunk as StreamChunk;

  switch (typed.type) {
    case "thought_delta":
      return {
        ...state,
        status: isWaiting(state.status) ? state.status : "running",
        streamingThinking: state.streamingThinking + (typed.delta ?? ""),
      };
    case "message_delta":
      return {
        ...state,
        status: isWaiting(state.status) ? state.status : "running",
        streamingText: state.streamingText + (typed.delta ?? ""),
      };
    case "tool_call":
      if (!typed.toolCall)
        return {
          ...state,
          status: isWaiting(state.status) ? state.status : "running",
        };
      return {
        ...state,
        status: isWaiting(state.status) ? state.status : "running",
        toolCalls: upsertToolCall(state.toolCalls, typed.toolCall),
      };
    case "tool_result":
      if (!typed.toolCall) return state;
      return {
        ...state,
        toolCalls: upsertToolCall(state.toolCalls, typed.toolCall),
      };
    case "permission_requested":
      if (!typed.permission) return { ...state, status: "waiting_permission" };
      return {
        ...state,
        status: "waiting_permission",
        permissions: upsertPermission(state.permissions, typed.permission),
        toolCalls: typed.toolCall
          ? upsertToolCall(state.toolCalls, typed.toolCall)
          : state.toolCalls,
      };
    case "run_failed":
      return {
        ...state,
        status: "failed",
        error: typed.error ?? "Agent run failed",
      };
    case "run_completed":
      return { ...state, status: "completed", error: null };
    case "input_injected":
      if (state.sessionId) {
        void useAgentSessionStore.getState().loadInputQueue(state.sessionId);
      }
      return {
        ...state,
        status: "running",
        streamingThinking: "",
        streamingText: "",
      };
    case "done":
      if (isWaiting(state.status)) return state;
      return { ...state, status: "completed", error: null };
    default:
      return state.status === "idle" ? { ...state, status: "running" } : state;
  }
}

export function applyDockLiveEvent(
  state: DockSessionState,
  event: SessionLiveEvent,
): DockSessionState {
  switch (event.type) {
    case "input_queue_changed":
      if (state.sessionId === event.sessionId)
        void useAgentSessionStore.getState().loadInputQueue(event.sessionId);
      return state;
    case "thought_delta":
      return {
        ...state,
        status: isWaiting(state.status) ? state.status : "running",
        streamingThinking: state.streamingThinking + event.delta,
      };
    case "message_delta":
      return {
        ...state,
        status: isWaiting(state.status) ? state.status : "running",
        streamingText: state.streamingText + event.delta,
      };
    case "tool_call":
      return {
        ...state,
        status: isWaiting(state.status) ? state.status : "running",
        toolCalls: upsertToolCall(state.toolCalls, event.toolCall),
      };
    case "tool_result":
      return {
        ...state,
        toolCalls: upsertToolCall(state.toolCalls, event.toolCall),
      };
    case "step_started":
      return {
        ...state,
        status: isWaiting(state.status) ? state.status : "running",
      };
    case "runtime_state":
      // Stream records carry the authoritative session patch: the only event
      // that reports a `waiting_input` checkpoint in the dock.
      return applyDockSessionPatch(
        state,
        event.patch as Record<string, unknown>,
      );
    default:
      return state;
  }
}

export function applyDockSessionPatch(
  state: DockSessionState,
  patch: Record<string, unknown>,
): DockSessionState {
  const next = { ...state };
  if (patch.status === "running") {
    // A queued `running` patch must not erase a form nobody answered yet.
    if (!holdsAnsweredForm(state)) {
      next.status = "running";
      next.error = null;
    }
  }
  if (patch.status === "waiting_permission" || patch.status === "waiting_input") {
    next.status = patch.status;
    if (patch.status === "waiting_input" && state.sessionId) {
      // The dock renders the form instead of its prompt: make sure it is loaded.
      void useAgentSessionStore
        .getState()
        .refreshInteractions(state.sessionId);
    }
  }
  if (patch.status === "completed") {
    next.status = "completed";
    next.error = null;
  }
  if (
    patch.status === "failed" ||
    patch.status === "interrupted" ||
    patch.status === "cancelled"
  ) {
    next.status = "failed";
  }
  if (typeof patch.blockedReason === "string") {
    next.error = patch.blockedReason;
  }
  if (typeof patch.title === "string") {
    next.title = patch.title.trim() || null;
  }
  return next;
}

export function isDockSessionActive(status: DockSessionStatus): boolean {
  return status === "running" || isWaiting(status);
}

export async function streamDockSessionTurn(
  sessionId: string,
  input: {
    message?: string;
    contentParts?: RuntimeContentPart[];
    model?: string | null;
    permissionTier?: "boundary" | "auto" | "unrestricted";
    reasoningEffort?: ReasoningEffort;
  },
  onChunk: (chunk: unknown) => void,
  options?: { continue?: boolean },
): Promise<void> {
  const locale = useShellStore.getState().preferences.locale;
  const body = {
    ...(input.contentParts ? { contentParts: input.contentParts } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.permissionTier ? { permissionTier: input.permissionTier } : {}),
    ...(input.reasoningEffort
      ? { reasoningEffort: input.reasoningEffort }
      : {}),
    locale,
  };
  if (options?.continue) {
    await agentRuntimeApi.resumeStream(sessionId, body, onChunk);
  } else {
    await agentRuntimeApi.streamTurn(sessionId, body, onChunk);
  }
}

export async function fetchDockSessionPermissions(
  sessionId: string,
): Promise<PermissionDecision[]> {
  const { items } = await agentRuntimeApi.listPermissions(sessionId);
  return items;
}
