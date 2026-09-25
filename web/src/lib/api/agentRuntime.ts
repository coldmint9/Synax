import { AuthenticatedEventSource } from "./authenticatedEventSource";
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

import { apiFetch, apiRequest, type ApiRequestOptions } from "./origin";
import { createAppError, handleError } from "../errors";
import type { SkillSummary } from "./skills";
import { streamCommitMessage } from "./commitMessageStream";
import type { CommitMessageStreamEvent } from "./commitMessageStream";

const BASE = "/api/agent-runtime";

export type AgentProfileKind = "planner" | "executor" | "reviewer" | "explorer";
export type AgentMode = "primary" | "subagent";
export type ThinkingMode = "fast" | "standard" | "deep";
export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type AgentSessionStatus =
  | "stopping"
  | "queued"
  | "running"
  | "waiting_permission"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

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
  recommended?: string[];
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

/** Sparse session projection served by GET /sessions/badges. */
export interface SessionBadgeRow {
  id: string;
  projectId: string;
  status: AgentSession["status"];
  updatedAt: string;
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
  historyProjection?: { omittedFields: string[] };
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

export type QueuedMoveTarget =
  | { direction: "up" | "down" }
  | { toIndex: number };

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

export type GitWorkspaceSelection =
  | { kind: "default" }
  | { kind: "worktree"; path: string }
  | { kind: "branch"; branch: string };

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
  permissionTier?: "boundary" | "auto" | "unrestricted";
  gitWorkspace?: GitWorkspaceSelection;
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

export interface ArchiveSessionResult {
  ok: true;
  archiveBatchId: string;
  archivedAt: string;
  archivedSessionIds: string[];
  parentId: string | null;
}

export interface SessionArchiveItem {
  archiveBatchId: string;
  rootSessionId: string;
  title: string | null;
  prompt: string;
  projectId: string;
  archivedAt: string;
  sessionCount: number;
  scheduledDeletionAt: string | null;
}

export interface SessionUsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite?: number;
  cacheReadMatched?: number;
  cacheInputMatched?: number;
  cacheReadRatio?: number | null;
  total: number;
}
export interface SessionUsageCoverage {
  requests: number;
  recorded: number;
  missing: number;
  complete: boolean;
  cacheReadKnown?: number;
  cacheReadUnknown?: number;
  cacheWriteKnown?: number;
  cacheWriteUnknown?: number;
  cacheMatched?: number;
}
export interface ContextComposition {
  version?: 2;
  tools: number;
  mcp: number;
  skills: number;
  messages: number;
  system?: number;
  usage?: { tools: number; mcp: number; skills: number };
  total: number;
  measuredAt: string;
}
export interface CacheUsageSample {
  stepId: string;
  measuredAt: string;
  model: string | null;
  unit: "request" | "external-turn";
  inputTokens: number | null;
  cacheReadTokens: number | null;
  ratio: number | null;
  status: "reported" | "missing" | "invalid" | "empty";
  inputSource: string;
  cacheSource: string;
}
export interface CacheUsageSummary {
  inputTokens: number;
  cacheReadTokens: number;
  ratio: number | null;
  weightedRatio: number | null;
  empty: number;
  aggregated: number;
  samples: number;
  matched: number;
  missing: number;
  invalid: number;
}
export interface SessionCacheUsage {
  latest: CacheUsageSample | null;
  recent: CacheUsageSummary;
  session: CacheUsageSummary;
  recentSamples: CacheUsageSample[];
  pending: number;
}

export interface SessionStats {
  cache?: SessionCacheUsage;
  roundCount?: number;
  /** Legacy estimates, ignored by usage displays. New servers return null. */
  contextComposition?: ContextComposition | null;
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
    /** "estimate" is accepted only for legacy responses and is never displayed. */
    source?: "provider" | "estimate" | null;
    stale?: boolean;
    requestId: string | null;
    measuredAt: string | null;
    latestRequestUsageAvailable: boolean;
  };
  usage?: {
    self: SessionUsageTotals;
    tree: SessionUsageTotals;
    steps?: { self: SessionUsageTotals; tree: SessionUsageTotals };
    auxiliary?: { self: SessionUsageTotals; tree: SessionUsageTotals };
  };
  coverage?: {
    self: SessionUsageCoverage;
    tree: SessionUsageCoverage;
    steps?: { self: SessionUsageCoverage; tree: SessionUsageCoverage };
    auxiliary?: { self: SessionUsageCoverage; tree: SessionUsageCoverage };
  };
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
  status: AgentSessionStatus;
  title: string | null;
  prompt: string;
  updatedAt: string;
  completedAt: string | null;
  resultSummary: string | null;
}

export type SessionEnvironmentInputSourceKind =
  | "file"
  | "search"
  | "command"
  | "url"
  | "attachment"
  | "tool";

export interface SessionEnvironmentInputSource {
  toolCallId?: string;
  kind: SessionEnvironmentInputSourceKind;
  label: string;
  path?: string;
  assetId?: string;
}

export interface SessionBackgroundProcess {
  id: string;
  command: string;
  pid: number | null;
  state: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  terminalId?: string;
  kind?: "terminal" | "service";
  cwd?: string;
  projectId?: string;
  /** Listening/mapped ports inferred from the service command; services only. */
  ports?: number[];
}

export interface SessionEnvironment {
  repositories?: SessionEnvironmentRepository[];
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
  /** Optional for historical snapshots; independent of uncommitted Git changes. */
  outputFiles?: string[];
  inputSources: SessionEnvironmentInputSource[];
  subagents: SessionEnvironmentSubagent[];
  refreshedAt: string;
}

export interface SessionEnvironmentRepository {
  rootId: string;
  name: string;
  role: "primary" | "reference";
  status: "ready" | "missing" | "not_repository" | "error";
  workspacePath: string;
  branch: string;
  headCommitSha: string;
  dirty: boolean;
  additions: number;
  deletions: number;
  changedFiles: SessionEnvironmentFile[];
  agentChangedFiles: SessionEnvironmentFile[];
  outputFiles?: string[];
  inputSources: SessionEnvironmentInputSource[];
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
  /** Retained for older clients; explicit commits always return false. */
  messageGenerated: boolean;
  /** `null` for a commit-only run, where no push was attempted. */
  pushed: boolean | null;
  upstream: string | null;
  committedFiles: number;
}

export interface SessionMcpServerSummary {
  id: string;
  name: string;
  enabled: boolean;
  toolCount: number;
}

export type SessionInvocationKind = "tool" | "skill" | "mcp";

export interface SessionInvocationUsageItem {
  kind: SessionInvocationKind;
  id: string;
  label: string;
  callCount: number;
  lastCalledAt: string;
}

export interface SessionInvocationUsageResponse {
  items: SessionInvocationUsageItem[];
  totalCalls: number;
}

export interface ProjectToolGrant {
  projectId: string;
  toolId: string;
  permissionId: string;
  createdAt: string;
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

export interface TurnReferenceOption extends TurnReference {
  recent?: boolean;
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
  permissionTier?: "boundary" | "auto" | "unrestricted";
  permissionOverrides?: Partial<
    Record<
      "read" | "write" | "delete" | "shell" | "task",
      "allow" | "ask" | "deny"
    >
  >;
}

async function request<T>(path: string, init?: ApiRequestOptions): Promise<T> {
  return apiRequest<T>(`${BASE}${path}`, init);
}

async function requestBlob(
  path: string,
  init?: ApiRequestOptions,
): Promise<Blob> {
  const response = await apiFetch(`${BASE}${path}`, init);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as {
        error?: string;
        message?: string;
      };
      message = body.error ?? body.message ?? message;
    } catch {
      // Keep the status fallback for non-JSON errors.
    }
    throw new Error(message);
  }
  return response.blob();
}

export interface SessionSearchResponse {
  items: Array<{ session: AgentSession; snippet: string }>;
  hasMore: boolean;
}

export interface HistoryWindowState {
  revision: number;
  epoch: number;
  cursor?: string;
  olderCursor?: string;
  hasEarlier: boolean;
  latest: boolean;
  detailsTruncated: boolean;
}
export interface HistoryWindowResponse {
  messages: AgentRuntimeMessage[];
  runs: AgentRun[];
  steps: AgentRunStep[];
  toolCalls: ToolCallRecord[];
  events: RuntimeEvent[];
  permissions: PermissionDecision[];
  historyWindow: HistoryWindowState;
}

export const agentRuntimeApi = {
  compactContext: (sessionId: string) =>
    request<{ accepted: true; status: "compacting" }>(`/sessions/${encodeURIComponent(sessionId)}/context/compact`, {
      method: "POST",
    }),
  searchSessions: (
    projectId: string,
    q: string,
    offset = 0,
    signal?: AbortSignal,
  ) =>
    request<SessionSearchResponse>(
      `/sessions/search?${new URLSearchParams({ projectId, q, offset: String(offset) })}`,
      // Search owns its inline error/retry UI. Avoid duplicate global toasts.
      { signal, silent: true },
    ),

  listReferenceOptions: (
    projectId: string,
    kind: TurnReference["kind"],
    q = "",
    sessionId?: string,
  ) =>
    apiRequest<{ items: TurnReferenceOption[] }>(
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
        body: JSON.stringify({}),
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
    request<ArchiveSessionResult>(`/sessions/${encodeURIComponent(sessionId)}/archive`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  clearInactiveSessions: (projectId: string) =>
    request<{ ok: true; archivedBatchCount: number; archivedCount: number; archivedSessionIds: string[] }>(
      `/sessions/archive-inactive`,
      { method: "POST", body: JSON.stringify({ projectId }) },
    ),
  listSessionArchives: (query: { projectId?: string; q?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "")
        qs.set(key, String(value));
    });
    return request<{ items: SessionArchiveItem[]; totalCount: number }>(
      `/session-archives${qs.size ? `?${qs.toString()}` : ""}`,
    );
  },
  restoreSessionArchive: (batchId: string) =>
    request<{ ok: true; restoredSessionIds: string[] }>(
      `/session-archives/${encodeURIComponent(batchId)}/restore`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  permanentlyDeleteSessionArchive: (batchId: string) =>
    request<{ ok: true; deletedSessionIds: string[] }>(
      `/session-archives/${encodeURIComponent(batchId)}`,
      { method: "DELETE" },
    ),
  messageContentPage: (sessionId: string, messageId: string, cursor = 0, revision?: number) =>
    request<{ text: string; next?: number; revision: number }>(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/content?cursor=${cursor}${revision === undefined ? "" : `&revision=${revision}`}`),
  historyWindow: (sessionId: string, cursor?: string) =>
    request<HistoryWindowResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/history-window${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      { silent: true },
    ),
  upgradeHistory: (sessionId: string) =>
    request<{ upgraded: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/history/upgrade`, {
      method: "POST", body: JSON.stringify({ acknowledgeCheckpointReset: true }),
    }),
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
  listProjectToolGrants: (projectId: string) =>
    request<{ items: ProjectToolGrant[] }>(
      `/projects/${encodeURIComponent(projectId)}/tool-grants`,
    ),
  revokeProjectToolGrant: (projectId: string, toolId: string) =>
    request<{ revoked: boolean }>(
      `/projects/${encodeURIComponent(projectId)}/tool-grants/${encodeURIComponent(toolId)}`,
      { method: "DELETE" },
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
  getSessionInputSource: (sessionId: string, toolCallId: string) =>
    request<{ content: string; truncated: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/environment/input-source/${encodeURIComponent(toolCallId)}`,
    ),
  /** Sparse id/status/updatedAt rows for badge counts; avoids full list payloads. */
  listSessionBadges: (projectIds: string[]) =>
    request<{ items: SessionBadgeRow[] }>(
      `/sessions/badges?${new URLSearchParams({ projectIds: projectIds.join(",") })}`,
    ),
  listSessionProcesses: (sessionId: string) =>
    request<{ items: SessionBackgroundProcess[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/processes`,
    ),
  deleteSessionProcess: (sessionId: string, processId: string) =>
    request<{ items: SessionBackgroundProcess[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}`,
      { method: "DELETE" },
    ),
  stopSessionProcess: (sessionId: string, processId: string) =>
    request<{ items: SessionBackgroundProcess[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}/stop`,
      { method: "POST" },
    ),
  listSessionBranches: (sessionId: string, rootId?: string) =>
    request<SessionGitBranches>(
      `/sessions/${encodeURIComponent(sessionId)}/git/branches${rootId ? `?rootId=${encodeURIComponent(rootId)}` : ""}`,
    ),
  switchSessionBranch: (sessionId: string, branch: string, rootId?: string) =>
    request<SessionGitBranches>(
      `/sessions/${encodeURIComponent(sessionId)}/git/branches/switch`,
      {
        method: "POST",
        body: JSON.stringify({ branch, rootId }),
      },
    ),
  getSessionEnvironment: (sessionId: string) =>
    request<SessionEnvironment>(
      `/sessions/${encodeURIComponent(sessionId)}/environment`,
    ),
  getSessionEnvironmentFile: (
    sessionId: string,
    path: string,
    kind: "diff" | "input",
    rootId?: string,
  ) =>
    request<SessionEnvironmentFileView>(
      `/sessions/${encodeURIComponent(sessionId)}/environment/file?kind=${encodeURIComponent(kind)}&path=${encodeURIComponent(path)}${rootId ? `&rootId=${encodeURIComponent(rootId)}` : ""}`,
    ),
  getSessionEnvironmentFileMedia: (
    sessionId: string,
    path: string,
    rootId?: string,
  ) =>
    requestBlob(
      `/sessions/${encodeURIComponent(sessionId)}/environment/file/media?path=${encodeURIComponent(path)}${rootId ? `&rootId=${encodeURIComponent(rootId)}` : ""}`,
    ),
  saveSessionEnvironmentFile: (
    sessionId: string,
    path: string,
    content: string,
    rootId?: string,
  ) =>
    request<{ sessionId: string; path: string; bytes: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/environment/file`,
      {
        method: "PUT",
        body: JSON.stringify({ path, content, rootId }),
      },
    ),
  streamCommitMessage: (
    sessionId: string,
    body: { rootId?: string; model: string },
    onEvent: (event: CommitMessageStreamEvent) => void,
    signal: AbortSignal,
  ) => streamCommitMessage(sessionId, body, onEvent, signal),
  commitSessionWorkspace: (
    sessionId: string,
    body: {
      message: string;
      push?: boolean;
      rootId?: string;
      includeUntracked?: boolean;
    },
  ) =>
    request<SessionGitCommitResult>(
      `/sessions/${encodeURIComponent(sessionId)}/git/commit`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  openSessionFileInSystemTerminal: (
    sessionId: string,
    body: { path: string; rootId?: string },
  ) =>
    request<{ ok: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/environment/file/system-terminal`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  trashSessionEnvironmentFile: (
    sessionId: string,
    body: { path: string; rootId?: string },
  ) =>
    request<{ sessionId: string; path: string; trashed: true }>(
      `/sessions/${encodeURIComponent(sessionId)}/environment/file/trash`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  renameSessionEnvironmentFile: (
    sessionId: string,
    body: { path: string; newName: string; rootId?: string },
  ) =>
    request<{ sessionId: string; path: string; previousPath: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/environment/file/rename`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  restoreSessionFile: (
    sessionId: string,
    body: { path: string; rootId?: string },
  ) =>
    request<{ rootId: string; path: string; deleted: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/git/files/restore`,
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
  getSessionInvocationUsage: (sessionId: string) =>
    request<SessionInvocationUsageResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/invocation-usage`,
    ),
  // Submitting is a short idempotent HTTP request. Observing the accepted run
  // shares the WS transport instead of holding another HTTP/1.1 connection.
  resumeStream: (sessionId: string, body: StreamTurnRequest, onChunk: (chunk: unknown) => void) =>
    submitAndObserveRun(sessionId, body, onChunk, "continue"),
  streamTurn: (sessionId: string, body: StreamTurnRequest, onChunk: (chunk: unknown) => void) =>
    submitAndObserveRun(sessionId, body, onChunk, "turn"),

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

  moveQueuedInput: (
    sessionId: string,
    itemId: string,
    target: QueuedMoveTarget,
  ) =>
    apiRequest<{ items: QueuedInput[] }>(
      `${BASE}/sessions/${encodeURIComponent(sessionId)}/input-queue/${encodeURIComponent(itemId)}/order`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      },
    ),

  forceQueuedInput: (sessionId: string, itemId: string) =>
    apiRequest<{ items: QueuedInput[]; forceInjectItemId: string }>(
      `${BASE}/sessions/${encodeURIComponent(sessionId)}/input-queue/${encodeURIComponent(itemId)}/force`,
      { method: "POST" },
    ),
};

export interface SessionGitBranches {
  rootId: string;
  current: string;
  branches: { name: string; current: boolean; occupied: boolean }[];
}

async function submitAndObserveRun(
  sessionId: string, body: StreamTurnRequest, onChunk: (chunk: unknown) => void, mode: "turn" | "continue",
): Promise<void> {
  const { run } = await agentRuntimeApi.submitRun(sessionId, body, crypto.randomUUID(), mode);
  await new Promise<void>((resolve, reject) => {
    const source = new AuthenticatedEventSource(`${BASE}/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(run.id)}/stream`);
    let cursor = 0;
    source.onmessage = event => {
      if (event.data === "[DONE]") { source.close(); resolve(); return; }
      const next = Number(event.lastEventId);
      if (Number.isSafeInteger(next) && next > 0) {
        if (next <= cursor) return;
        cursor = next;
      }
      try { onChunk(JSON.parse(event.data)); }
      catch (error) { source.close(); reject(error); }
    };
    source.onerror = () => {
      if (source.readyState !== AuthenticatedEventSource.CLOSED) return;
      const error = createAppError("Run observation is unavailable. Reload the session to recover its persisted result.", 503);
      handleError(error); reject(error);
    };
  });
}
