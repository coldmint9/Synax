import type { RuntimeContentPart, InputModality } from "./runtimeMedia";
export type { RuntimeContentPart } from "./runtimeMedia";
export type BackendId =
  | "native"
  | "codex"
  | "claude-code"
  | "opencode-acp"
  | "cursor-acp"
  | "codex-acp"
  | "pi-acp";

import { apiFetch, apiRequest } from "./origin";
import { createAppError, handleError } from "../errors";
import type { SkillSummary } from "./skills";

const BASE = "/api/agent-runtime";

export type AgentProfileKind = "planner" | "executor" | "reviewer" | "explorer";
export type AgentMode = "primary" | "subagent";
export type ThinkingMode = "fast" | "standard" | "deep";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentSessionStatus =
  | "stopping"
  | "queued"
  | "running"
  | "waiting_permission"
  | "waiting_input"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "paused";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_permission"
  | "waiting_input"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AgentProfile {
  id: string;
  label: string;
  kind: AgentProfileKind;
  mode: AgentMode;
  description: string;
  defaultThinkingMode: ThinkingMode;
  allowedCapabilities: string[];
  /** Soft round convergence threshold; retained under the legacy name for compatibility. */
  maxSteps: number;
  status: "active" | "disabled";
  allowsSubsessions?: boolean;
}

export type AgentSessionMode = "chat" | "plan" | "goal";

export interface HumanQuestion {
  id: string;
  type:
    | "single_select"
    | "multi_select"
    | "text"
    | "textarea"
    | "number"
    | "boolean";
  label: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  allowOther?: boolean;
  min?: number;
  max?: number;
}

export interface AgentPlan {
  title: string;
  objective: string;
  steps: {
    id: string;
    title: string;
    description: string;
    dependsOn: string[];
    expectedFiles: string[];
  }[];
  acceptanceCriteria: string[];
  humanAcceptanceCriteria?: string[];
  assumptions: string[];
  risks: string[];
}

export interface AgentGoalState {
  objective: string;
  status:
    | "planning"
    | "executing"
    | "completed"
    | "blocked"
    | "budget_exhausted"
    | "cancelled";
  acceptanceEvidence?: unknown;
  reason?: string;
}

export interface AgentSessionMetadata extends Record<string, unknown> {
  mode?: AgentSessionMode | "plan_node";
  plan?:
    | (AgentPlan & { revision: number; status: "draft" | "approved" | "saved" })
    | null;
  goal?: AgentGoalState | null;
}

export interface AgentInteractionReply {
  revision: number;
  action: "submit" | "decline" | "cancel" | "save" | "revise" | "execute";
  answers?: Record<string, string | string[] | number | boolean>;
  message?: string;
}

export interface AgentInteraction {
  id: string;
  sessionId: string;
  runId: string;
  stepId: string;
  toolCallId: string;
  kind: "clarification" | "plan_approval";
  revision: number;
  status: "pending" | "answered" | "declined" | "cancelled";
  request: { title: string; questions?: HumanQuestion[]; plan?: AgentPlan };
  response: AgentInteractionReply | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AgentSession {
  id: string;
  projectId: string;
  parentSessionId: string | null;
  childSessionIds: string[];
  nodeId: string | null;
  profileId: string;
  status: AgentSessionStatus;
  title: string | null;
  prompt: string;
  contextSnapshotId: string | null;
  thinkingMode: ThinkingMode;
  reasoningEffort?: ReasoningEffort | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  resultSummary: string | null;
  blockedReason: string | null;
  skillIds: string[];
  mcpServerIds?: string[];
  activeRunId: string | null;
  pendingResumeToken: string | null;
  model: string | null;
  sessionMetadata?: AgentSessionMetadata | null;
}

export interface AgentRun {
  id: string;
  sessionId: string;
  status: AgentRunStatus;
  startedAt: string;
  completedAt: string | null;
  triggerMessageId: string | null;
  currentStep: number;
  stopReason: string | null;
  model: string | null;
  metadata: Record<string, unknown>;
}

export type AgentRunStepStatus = Exclude<AgentRunStatus, "queued">;

export interface AgentRunStep {
  id: string;
  runId: string;
  sessionId: string;
  index: number;
  status: AgentRunStepStatus;
  model: string | null;
  startedAt: string;
  completedAt: string | null;
  finishReason: string | null;
  metadata: Record<string, unknown>;
}

export type ToolCallStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  | "compacted";

export interface ToolCallRecord {
  outputRef?: unknown;
  contentParts?: RuntimeContentPart[];
  id: string;
  sessionId: string;
  runId: string | null;
  stepId: string | null;
  toolId: string;
  category: string;
  mutability: "read" | "write" | "task";
  inputSummary: string;
  outputSummary: string | null;
  status: ToolCallStatus;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface RuntimeEvent {
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
  visibility: "user_visible" | "internal";
  summary: string;
  payload: Record<string, unknown>;
}

export interface AgentRuntimeMessage {
  contentParts?: RuntimeContentPart[];
  id: string;
  sessionId: string;
  runId: string | null;
  stepId: string | null;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentWork {
  id: string;
  sessionId: string;
  parentWorkId: string | null;
  objective: string;
  status:
    | "active"
    | "waiting"
    | "closing"
    | "completed"
    | "blocked"
    | "cancelled";
  remaining: string[];
  progressVersion: number;
  result: string | null;
  reason: string | null;
}

export interface SessionPayload {
  work?: AgentWork | null;
  session: AgentSession;
  profile: AgentProfile;
  context: AgentContextBundle | null;
}

export interface AgentContextBundle {
  id: string;
  projectId: string;
  sessionId: string | null;
  nodeId: string | null;
  profileId: string | null;
  blocks: Array<{ id: string; kind: string; title: string; content: string }>;
  citations: Array<Record<string, unknown>>;
  warnings: string[];
  createdAt: string;
}

export interface QueuedInput {
  contentParts?: RuntimeContentPart[];
  references?: TurnReference[];
  id: string;
  message: string;
  model: string | null;
  reasoningEffort?: ReasoningEffort | null;
  enqueuedAt: string;
}

export interface PermissionDecision {
  id: string;
  sessionId: string;
  runId: string | null;
  stepId: string | null;
  toolCallId: string | null;
  coarseCategory: "read" | "write" | "external_execution" | "high_risk";
  internalGate: string;
  action: "allow" | "ask" | "deny";
  reason: string;
  patterns: string[];
  userReply: "once" | "always" | "reject" | null;
  createdAt: string;
  resolvedAt: string | null;
  resumeToken: string | null;
  metadata: Record<string, unknown>;
}

export interface EvidenceArtifact {
  id: string;
  sessionId: string;
  kind: string;
  title: string;
  summary: string;
  sourceRefs: Array<{ type: string; id?: string; path?: string }>;
  risk: "low" | "medium" | "high" | "unknown";
  createdAt: string;
}

export interface CreateSessionRequest {
  backendId?: BackendId;
  model?: string;
  workDir?: string;
  projectId: string;
  nodeId?: string | null;
  profileId: string;
  parentSessionId?: string | null;
  prompt: string;
  thinkingMode?: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
  skillIds?: string[];
  mcpServerIds?: string[];
  sessionMetadata?: Record<string, unknown> | null;
  permissionTier?: "readonly" | "readwrite" | "unrestricted";
  permissionOverrides?: Partial<
    Record<
      "read" | "write" | "delete" | "shell" | "task",
      "allow" | "ask" | "deny"
    >
  >;
}

export interface SessionListResponse {
  items: AgentSession[];
  totalCount: number;
  countByStatus: Record<string, number>;
}

export interface DeleteSessionResult {
  ok: true;
  deletedSessionIds: string[];
}

export interface SessionUsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  total: number;
}
export interface SessionUsageCoverage {
  requests: number;
  recorded: number;
  missing: number;
  complete: boolean;
}
export interface SessionStats {
  work?: {
    id: string;
    status:
      | "active"
      | "waiting"
      | "closing"
      | "completed"
      | "blocked"
      | "cancelled";
    remaining: string[];
    reason: string | null;
  } | null;
  context?: {
    inputTokens: number | null;
    requestId: string | null;
    measuredAt: string | null;
    latestRequestUsageAvailable: boolean;
  };
  usage?: { self: SessionUsageTotals; tree: SessionUsageTotals };
  coverage?: { self: SessionUsageCoverage; tree: SessionUsageCoverage };
  tokenUsage: { input: number; output: number; total: number };
  contextLimit: number;
  contextLimitKnown?: boolean;
  contextUsedPercent: number;
  toolCallCount: number;
  runningDuration: number;
  status: AgentSessionStatus;
  activeSubAgentCount: number;
}

export interface TodoItem {
  id: string;
  label: string;
  status: "pending" | "in_progress" | "done";
}

export interface AgentToolSummary {
  id: string;
  label: string;
  description: string;
  category: string;
  mutability: "read" | "write" | "task";
}

export type EnvironmentChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "unknown";

export interface SessionEnvironmentFile {
  path: string;
  status: EnvironmentChangeStatus;
  additions: number;
  deletions: number;
  staged: boolean;
  untracked: boolean;
}

export interface SessionEnvironmentSubagent {
  id: string;
  parentSessionId: string | null;
  profileId: string;
  status: string;
  title: string | null;
  prompt: string;
  updatedAt: string;
  completedAt: string | null;
  resultSummary: string | null;
}

export interface SessionEnvironment {
  sessionId: string;
  projectId: string;
  workspacePath: string;
  branch: string;
  headCommitSha: string;
  dirty: boolean;
  additions: number;
  deletions: number;
  changedFiles: SessionEnvironmentFile[];
  /** Files this session's agent wrote/edited/deleted (still uncommitted). */
  agentChangedFiles: SessionEnvironmentFile[];
  inputFiles: string[];
  subagents: SessionEnvironmentSubagent[];
  refreshedAt: string;
}

export interface SessionEnvironmentFileView {
  sessionId: string;
  path: string;
  kind: "diff" | "input";
  content: string;
  truncated: boolean;
}

export interface SessionGitCommitResult {
  branch: string;
  commitSha: string;
  message: string;
  /** True when the message was generated because the user left the input empty. */
  messageGenerated: boolean;
  pushed: boolean;
  upstream: string | null;
  committedFiles: number;
}

export interface SessionMcpServerSummary {
  id: string;
  name: string;
  enabled: boolean;
  toolCount: number;
}

export interface SessionCapabilities {
  backend?: {
    id: BackendId;
    label: string;
    kind: "native" | "acp" | "cli";
    capabilities: Record<string, "supported" | "unsupported" | "unverified">;
  };
  profile: { id: string; label: string; kind: string };
  tools: {
    available: AgentToolSummary[];
    visible: AgentToolSummary[];
  };
  skills: {
    active: SkillSummary[];
    candidates: SkillSummary[];
  };
  mcp: {
    servers: SessionMcpServerSummary[];
  };
}

export interface TurnReference {
  kind: "skill" | "mcp" | "file" | "wiki";
  id: string;
  label?: string;
}

export interface StreamTurnRequest {
  contentParts?: RuntimeContentPart[];
  references?: TurnReference[];
  message?: string;
  /** Marks a prompt the app composed on the user's behalf (goal scaffolding). */
  messageSource?: "user" | "system_injection";
  model?: string;
  purpose?: string;
  temperature?: number;
  maxTokens?: number;
  /** Soft round convergence threshold, not an execution cap. */
  maxSteps?: number;
  locale?: "zh" | "en";
  reasoningEffort?: ReasoningEffort;
  permissionTier?: "readonly" | "readwrite" | "unrestricted";
  permissionOverrides?: Partial<
    Record<
      "read" | "write" | "delete" | "shell" | "task",
      "allow" | "ask" | "deny"
    >
  >;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return apiRequest<T>(`${BASE}${path}`, init);
}

export const agentRuntimeApi = {
  listReferenceOptions: (
    projectId: string,
    kind: TurnReference["kind"],
    q = "",
    sessionId?: string,
  ) =>
    apiRequest<{ items: TurnReference[] }>(
      `${BASE}/projects/${encodeURIComponent(projectId)}/references?${new URLSearchParams({ kind, q, ...(sessionId ? { sessionId } : {}) })}`,
    ),

  listBackends: () =>
    request<{
      items: Array<{
        id: BackendId;
        label: string;
        kind: "native" | "acp" | "cli";
        experimental?: boolean;
      }>;
    }>("/backends"),
  listBackendModels: (id: BackendId) =>
    request<{
      models: Array<{
        id: string;
        label: string;
        efforts?: string[];
        inputModalities?: InputModality[];
      }>;
      defaultModel?: string | null;
    }>(`/backends/${encodeURIComponent(id)}/models`),
  acknowledgeRecovery: (sessionId: string) =>
    request<{ session: AgentSession }>(
      `/sessions/${encodeURIComponent(sessionId)}/recovery`,
      {
        method: "POST",
        body: JSON.stringify({
          reviewedWorkspace: true,
          confirmedNoRemainingWork: true,
        }),
      },
    ),
  submitRun: (
    sessionId: string,
    body: StreamTurnRequest,
    requestId: string,
    mode: "turn" | "continue" = "turn",
  ) =>
    request<{ run: AgentRun; reused: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/runs`,
      {
        method: "POST",
        body: JSON.stringify({ ...body, requestId, mode }),
      },
    ),
  listProfiles: () => request<{ items: AgentProfile[] }>("/profiles"),
  buildContext: (
    projectId: string,
    body: { nodeId?: string | null; profileId?: string; include?: string[] },
  ) =>
    request<AgentContextBundle>(`/contexts/${encodeURIComponent(projectId)}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createSession: (body: CreateSessionRequest) =>
    request<SessionPayload>("/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listSessions: (
    query: {
      projectId?: string;
      nodeId?: string;
      status?: AgentSessionStatus;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null) qs.set(key, String(value));
    });
    return request<SessionListResponse>(
      `/sessions${qs.size ? `?${qs.toString()}` : ""}`,
    );
  },
  getSession: (sessionId: string) =>
    request<SessionPayload>(`/sessions/${encodeURIComponent(sessionId)}`),
  listInteractions: (sessionId: string) =>
    request<{ interactions: AgentInteraction[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/interactions`,
    ),
  replyInteraction: (
    sessionId: string,
    interactionId: string,
    body: AgentInteractionReply,
  ) =>
    request<{ interaction: AgentInteraction }>(
      `/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/reply`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  updateSessionMode: (sessionId: string, mode: AgentSessionMode) =>
    request<{ session: AgentSession }>(
      `/sessions/${encodeURIComponent(sessionId)}/mode`,
      {
        method: "PATCH",
        body: JSON.stringify({ mode }),
      },
    ),
  cancelSession: (sessionId: string, runId?: string | null) =>
    request<AgentSession>(`/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ runId: runId ?? undefined }),
    }),
  deleteSession: (sessionId: string) =>
    request<DeleteSessionResult>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }),
  clearInactiveSessions: (projectId: string) =>
    request<{ ok: true; deletedCount: number; deletedSessionIds: string[] }>(
      `/sessions/clear-inactive`,
      { method: "POST", body: JSON.stringify({ projectId }) },
    ),
  listMessages: (sessionId: string) =>
    request<{ items: AgentRuntimeMessage[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
    ),
  listRuns: (sessionId: string) =>
    request<{ items: AgentRun[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/runs`,
    ),
  getRun: (sessionId: string, runId: string) =>
    request<AgentRun>(
      `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`,
    ),
  listRunSteps: (sessionId: string, runId: string) =>
    request<{ items: AgentRunStep[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/steps`,
    ),
  listSessionSteps: (sessionId: string) =>
    request<{ items: AgentRunStep[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/steps`,
    ),
  listEvents: (sessionId: string, after?: string) =>
    request<{ items: RuntimeEvent[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/events${after ? `?after=${encodeURIComponent(after)}` : ""}`,
    ),
  listPermissions: (sessionId: string) =>
    request<{ items: PermissionDecision[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/permissions`,
    ),
  replyPermission: (
    sessionId: string,
    permissionId: string,
    reply: "once" | "always" | "reject",
    message?: string,
  ) =>
    request<PermissionDecision>(
      `/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ reply, message }),
      },
    ),
  updateSessionPermissions: (
    sessionId: string,
    body: Pick<CreateSessionRequest, "permissionTier" | "permissionOverrides">,
  ) =>
    request<SessionPayload>(
      `/sessions/${encodeURIComponent(sessionId)}/permissions`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    ),
  listArtifacts: (sessionId: string) =>
    request<{ items: EvidenceArtifact[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/artifacts`,
    ),
  listToolCalls: (sessionId: string) =>
    request<{ items: ToolCallRecord[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/tool-calls`,
    ),
  getSessionEnvironment: (sessionId: string) =>
    request<SessionEnvironment>(
      `/sessions/${encodeURIComponent(sessionId)}/environment`,
    ),
  getSessionEnvironmentFile: (
    sessionId: string,
    path: string,
    kind: "diff" | "input",
  ) =>
    request<SessionEnvironmentFileView>(
      `/sessions/${encodeURIComponent(sessionId)}/environment/file?kind=${encodeURIComponent(kind)}&path=${encodeURIComponent(path)}`,
    ),
  commitSessionWorkspace: (
    sessionId: string,
    body: { message?: string; model?: string } = {},
  ) =>
    request<SessionGitCommitResult>(
      `/sessions/${encodeURIComponent(sessionId)}/git/commit`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  getSessionStats: (sessionId: string) =>
    request<SessionStats>(`/sessions/${encodeURIComponent(sessionId)}/stats`),
  getSessionTodos: (sessionId: string) =>
    request<{ items: TodoItem[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/todos`,
    ),
  getSessionCapabilities: (sessionId: string) =>
    request<SessionCapabilities>(
      `/sessions/${encodeURIComponent(sessionId)}/capabilities`,
    ),
  pauseSession: (sessionId: string, runId?: string | null) =>
    request<AgentSession>(`/sessions/${encodeURIComponent(sessionId)}/pause`, {
      method: "POST",
      body: JSON.stringify({ runId: runId ?? undefined }),
    }),
  resumeStream: async (
    sessionId: string,
    body: StreamTurnRequest,
    onChunk: (chunk: unknown) => void,
  ): Promise<void> => {
    const response = await apiFetch(
      `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/resume/stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok || !response.body) {
      let message = `Agent runtime resume stream error ${response.status}`;
      let code: string | undefined;
      try {
        const b = (await response.json()) as { error?: string; code?: string };
        code = b.code;
        if (b.code) message = b.error ?? message;
        else if (b.error) message = b.error;
      } catch {
        /* keep default message */
      }
      const appErr = createAppError(message, response.status, code);
      handleError(appErr);
      throw appErr;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (dataLine) {
          const raw = dataLine.slice(6);
          if (raw === "[DONE]") return;
          try {
            onChunk(JSON.parse(raw) as unknown);
          } catch {
            onChunk(raw);
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  },
  streamTurn: async (
    sessionId: string,
    body: StreamTurnRequest,
    onChunk: (chunk: unknown) => void,
  ): Promise<void> => {
    const response = await apiFetch(
      `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/turns/stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok || !response.body) {
      let message = `Agent runtime turn stream error ${response.status}`;
      let code: string | undefined;
      try {
        const body = (await response.json()) as {
          error?: string;
          code?: string;
        };
        code = body.code;
        if (body.code) message = body.error ?? message;
        else if (body.error) message = body.error;
      } catch {
        /* keep default message */
      }
      const appErr = createAppError(message, response.status, code);
      handleError(appErr);
      throw appErr;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = frame
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (dataLine) {
          const raw = dataLine.slice(6);
          if (raw === "[DONE]") return;
          try {
            onChunk(JSON.parse(raw) as unknown);
          } catch {
            onChunk(raw);
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  },

  listInputQueue: (sessionId: string) =>
    apiRequest<{ items: QueuedInput[] }>(
      `${BASE}/sessions/${encodeURIComponent(sessionId)}/input-queue`,
    ),

  enqueueInput: (
    sessionId: string,
    body: {
      contentParts?: RuntimeContentPart[];
      message: string;
      model?: string | null;
      reasoningEffort?: ReasoningEffort | null;
      references?: TurnReference[];
    },
  ) =>
    apiRequest<{ items: QueuedInput[] }>(
      `${BASE}/sessions/${encodeURIComponent(sessionId)}/input-queue`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      },
    ),

  removeQueuedInput: (sessionId: string, itemId: string) =>
    apiRequest<{ items: QueuedInput[] }>(
      `${BASE}/sessions/${encodeURIComponent(sessionId)}/input-queue/${encodeURIComponent(itemId)}`,
      { method: "DELETE" },
    ),

  forceQueuedInput: (sessionId: string, itemId: string) =>
    apiRequest<{ items: QueuedInput[]; forceInjectItemId: string }>(
      `${BASE}/sessions/${encodeURIComponent(sessionId)}/input-queue/${encodeURIComponent(itemId)}/force`,
      { method: "POST" },
    ),
};
