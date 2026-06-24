import * as z from 'zod/v4';

export const agentProfileKindSchema = z.enum(['planner', 'executor', 'reviewer', 'explorer']);
export type AgentProfileKind = z.infer<typeof agentProfileKindSchema>;

export const agentModeSchema = z.enum(['primary', 'subagent']);
export type AgentMode = z.infer<typeof agentModeSchema>;

export const thinkingModeSchema = z.enum(['fast', 'standard', 'deep']);
export type ThinkingMode = z.infer<typeof thinkingModeSchema>;

export const sessionStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_permission',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'paused',
]);
export type AgentSessionStatus = z.infer<typeof sessionStatusSchema>;

export const runStatusSchema = z.enum([
  'running',
  'waiting_permission',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type AgentRunStatus = z.infer<typeof runStatusSchema>;

export const stepStatusSchema = z.enum([
  'running',
  'waiting_permission',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type AgentRunStepStatus = z.infer<typeof stepStatusSchema>;

export const permissionActionSchema = z.enum(['allow', 'ask', 'deny']);
export type PermissionAction = z.infer<typeof permissionActionSchema>;

export const permissionOverrideGateSchema = z.enum(['read', 'write', 'delete', 'shell', 'task']);
export type PermissionOverrideGate = z.infer<typeof permissionOverrideGateSchema>;

export const permissionTierSchema = z.enum(['readonly', 'readwrite', 'unrestricted']);
export type PermissionTier = z.infer<typeof permissionTierSchema>;

export const permissionOverridesSchema = z.partialRecord(
  permissionOverrideGateSchema,
  permissionActionSchema,
);
export type PermissionOverrides = z.infer<typeof permissionOverridesSchema>;


export const permissionReplySchema = z.enum(['once', 'always', 'reject']);
export type PermissionReply = z.infer<typeof permissionReplySchema>;

export const capabilityCategorySchema = z.enum([
  'read',
  'write',
  'external_execution',
  'task',
  'skill',
  'shell',
  'context',
  'review',
  'high_risk',
]);
export type CapabilityCategory = z.infer<typeof capabilityCategorySchema>;

export const internalGateSchema = z.enum(['task', 'skill', 'external_path', 'write', 'delete', 'shell', 'none']);
export type InternalGate = z.infer<typeof internalGateSchema>;

export const toolMutabilitySchema = z.enum(['read', 'write', 'task']);
export type ToolMutability = z.infer<typeof toolMutabilitySchema>;

export const toolResumeBehaviorSchema = z.enum(['none', 'wait_permission', 'auto']);
export type ToolResumeBehavior = z.infer<typeof toolResumeBehaviorSchema>;

export const runtimeEventTypeSchema = z.enum([
  'session_started',
  'session_blocked',
  'session_completed',
  'session_failed',
  'run_started',
  'run_resumed',
  'run_completed',
  'run_failed',
  'step_started',
  'step_completed',
  'message_delta',
  'thought_delta',
  'tool_call',
  'tool_result',
  'permission_requested',
  'permission_resolved',
  'artifact_created',
  'progress_updated',
  'subsession_started',
  'todo_updated',
  'task_state_updated',
]);
export type RuntimeEventType = z.infer<typeof runtimeEventTypeSchema>;

export const runtimeMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type RuntimeMessageRole = z.infer<typeof runtimeMessageRoleSchema>;

export const toolCallStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'denied',
  'cancelled',
  'compacted',
]);
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>;

export const runPartKindSchema = z.enum([
  'text',
  'thought',
  'tool_call',
  'tool_result',
  'system_note',
  'error',
]);
export type AgentRunPartKind = z.infer<typeof runPartKindSchema>;

export const evidenceArtifactKindSchema = z.enum([
  'evidence',
  'decision',
  'diff_summary',
  'review_result',
  'context_signal',
  'blocker',
]);
export type EvidenceArtifactKind = z.infer<typeof evidenceArtifactKindSchema>;

export const riskLevelSchema = z.enum(['low', 'medium', 'high', 'unknown']);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export interface PermissionRule {
  gate: InternalGate | CapabilityCategory | '*';
  pattern: string;
  action: PermissionAction;
  reason?: string;
}

export interface ToolPolicy {
  /** @deprecated All tools now execute in parallel within a step. Kept for backward compatibility. */
  allowParallelReadTools?: boolean;
  allowSubtasks?: boolean;
  /** @deprecated No longer capped. All tool calls in a step execute concurrently. Kept for backward compatibility. */
  maxParallelReadTools?: number;
}

export interface AgentProfile {
  id: string;
  label: string;
  kind: AgentProfileKind;
  mode: AgentMode;
  description: string;
  defaultThinkingMode: ThinkingMode;
  allowedCapabilities: string[];
  permissionDefaults: PermissionRule[];
  defaultSkills: string[];
  maxSteps: number;
  status: 'active' | 'disabled';
  toolPolicy?: ToolPolicy;
  loopHints?: string[];
  allowsSubsessions?: boolean;
  doomLoopThreshold?: number;
  /** After this many consecutive failures of the SAME tool, inject a corrective
   *  system-reminder to the model (instead of terminating the session). Defaults
   *  to 3 when unset. Read-only exploration profiles (explorer/verifier) may set
   *  a higher value since their bash probing fails more freely while self-healing. */
  consecutiveFailureReminderThreshold?: number;
  /** ID of a SessionToolProvider that supplies tools/hooks for this profile's sessions.
   *  The provider is consulted on every tool listing and execution so that
   *  paused/interrupted sessions recover their tool set on resume. */
  toolProviderId?: string;
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
  permissionRules: PermissionRule[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  resultSummary: string | null;
  blockedReason: string | null;
  skillIds: string[];
  activeRunId: string | null;
  pendingResumeToken: string | null;
  /** Arbitrary JSON payload for session-specific orchestrator state (wiki snapshot, pipeline phase, etc.).
   *  Persisted to DB so state survives pause/interrupt and server restart. */
  sessionMetadata: Record<string, unknown> | null;
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

export interface AgentRunPart {
  id: string;
  runId: string;
  stepId: string;
  sessionId: string;
  kind: AgentRunPartKind;
  sequence: number;
  content: string;
  toolCallId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RuntimeEvent {
  id: string;
  sessionId: string;
  type: RuntimeEventType;
  timestamp: string;
  visibility: 'user_visible' | 'internal';
  summary: string;
  payload: Record<string, unknown>;
}

export interface AgentRuntimeMessage {
  id: string;
  sessionId: string;
  runId: string | null;
  stepId: string | null;
  role: RuntimeMessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ToolCallRecord {
  id: string;
  sessionId: string;
  runId: string | null;
  stepId: string | null;
  modelToolCallId: string | null;
  toolId: string;
  category: CapabilityCategory;
  mutability: ToolMutability;
  argsHash: string;
  inputSummary: string;
  inputRef: unknown | null;
  outputSummary: string | null;
  outputRef: unknown | null;
  status: ToolCallStatus;
  permissionDecisionId: string | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface PermissionDecision {
  id: string;
  sessionId: string;
  runId: string | null;
  stepId: string | null;
  toolCallId: string | null;
  coarseCategory: 'read' | 'write' | 'external_execution' | 'high_risk';
  internalGate: InternalGate;
  action: PermissionAction;
  reason: string;
  patterns: string[];
  userReply: PermissionReply | null;
  createdAt: string;
  resolvedAt: string | null;
  resumeToken: string | null;
  metadata: Record<string, unknown>;
}

export interface AgentSkill {
  id: string;
  label: string;
  description: string;
  source: 'system' | 'project' | 'plugin' | 'user';
  version: string;
  appliesTo: AgentProfileKind[];
  requiredCapabilities: string[];
  permissionHints: InternalGate[];
  contentRef: string;
  content?: string;
  status: 'available' | 'unavailable' | 'invalid' | 'disabled';
}

export interface AgentContextBlock {
  id: string;
  kind: 'goal' | 'action' | 'memory' | 'code' | 'diff' | 'review' | 'wiki' | 'system';
  title: string;
  content: string;
  sourceType?: string;
  sourceId?: string;
}

export interface AgentCitation {
  id: string;
  path?: string;
  symbolId?: string;
  nodeId?: string;
  sourceId?: string;
}

export interface AgentContextBundle {
  id: string;
  projectId: string;
  sessionId: string | null;
  nodeId: string | null;
  profileId: string | null;
  blocks: AgentContextBlock[];
  citations: AgentCitation[];
  warnings: string[];
  createdAt: string;
}

export interface EvidenceArtifact {
  id: string;
  sessionId: string;
  kind: EvidenceArtifactKind;
  title: string;
  summary: string;
  sourceRefs: Array<{ type: string; id?: string; path?: string }>;
  risk: RiskLevel;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ThinkingSummary {
  id: string;
  sessionId: string;
  mode: ThinkingMode;
  framing: string;
  evidenceUsed: Array<{ toolCallId?: string; artifactId?: string; path?: string }>;
  decision: string;
  assumptions: string[];
  risks: string[];
  nextSteps: string[];
}

export const createSessionRequestSchema = z.object({
  projectId: z.string().min(1).max(128),
  nodeId: z.string().min(1).max(256).nullable().optional(),
  profileId: z.string().min(1).max(64),
  parentSessionId: z.string().min(1).max(64).nullable().optional(),
  prompt: z.string().min(1).max(100_000),
  thinkingMode: thinkingModeSchema.optional(),
  skillIds: z.array(z.string().min(1).max(128)).max(20).optional(),
  sessionMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
  permissionTier: permissionTierSchema.optional(),
  permissionOverrides: permissionOverridesSchema.optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const listSessionsQuerySchema = z.object({
  projectId: z.string().min(1).max(128).optional(),
  nodeId: z.string().min(1).max(256).optional(),
  status: sessionStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

export const permissionReplyRequestSchema = z.object({
  reply: permissionReplySchema,
  message: z.string().max(10_000).optional(),
});
export type PermissionReplyRequest = z.infer<typeof permissionReplyRequestSchema>;

export const buildContextRequestSchema = z.object({
  nodeId: z.string().min(1).max(256).nullable().optional(),
  profileId: z.string().min(1).max(64).optional(),
  include: z.array(z.enum(['coord', 'memory', 'graph', 'review', 'wiki'])).max(10).optional(),
});
export type BuildContextRequest = z.infer<typeof buildContextRequestSchema>;

export const listEventsQuerySchema = z.object({
  after: z.string().min(1).max(128).optional(),
});
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;

export const listSkillsQuerySchema = z.object({
  profileId: z.string().min(1).max(64).optional(),
  includeContent: z.coerce.boolean().default(false),
});
export type ListSkillsQuery = z.infer<typeof listSkillsQuerySchema>;

export const executeToolRequestSchema = z.object({
  toolId: z.string().min(1).max(128),
  args: z.unknown().optional(),
});
export type ExecuteToolRequest = z.infer<typeof executeToolRequestSchema>;

export const clearInactiveSessionsBodySchema = z.object({
  projectId: z.string().min(1).max(128),
});
export type ClearInactiveSessionsBody = z.infer<typeof clearInactiveSessionsBodySchema>;

export const streamTurnRequestSchema = z.object({
  message: z.string().min(1).max(100_000).optional(),
  model: z.string().min(1).max(256).optional(),
  purpose: z.string().min(1).max(64).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(200_000).optional(),
  maxSteps: z.number().int().positive().max(500).optional(),
  locale: z.enum(['zh', 'en']).optional(),
});
export type StreamTurnRequest = z.infer<typeof streamTurnRequestSchema>;

export interface ToolExecutionInput {
  sessionId: string;
  runId: string | null;
  stepId: string | null;
  toolCallId: string;
  toolId: string;
  category: CapabilityCategory;
  mutability: ToolMutability;
  args: unknown;
  pattern?: string;
}

export interface ToolExecutionArtifactInput {
  kind: EvidenceArtifactKind;
  title: string;
  summary: string;
  risk?: RiskLevel;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionResult {
  result: unknown;
  displaySummary: string;
  artifacts: ToolExecutionArtifactInput[];
  followUpHints?: string[];
}

export interface RegisteredTool {
  id: string;
  label: string;
  description: string;
  category: CapabilityCategory;
  internalGate?: InternalGate;
  mutability: ToolMutability;
  resumeBehavior: ToolResumeBehavior;
  patterns?: string[];
  progressiveDetails?: string;
  inputSchema?: z.ZodTypeAny;
  outputSchema?: z.ZodTypeAny;
  getPattern?: (args: unknown) => string | undefined;
  execute: (input: ToolExecutionInput) => Promise<ToolExecutionResult> | ToolExecutionResult;
}

export interface ToolHookContext {
  sessionId: string;
  runId: string | null;
  stepId: string | null;
  toolCallId: string;
  toolId: string;
  args: unknown;
  result: ToolExecutionResult;
}

export interface ToolHook {
  id: string;
  toolId: string | '*';
  afterExecute: (ctx: ToolHookContext) => Promise<void> | void;
}

/**
 * A provider that supplies session-scoped tools and hooks.
 * Implementations reconstruct tools/hooks from persisted state (e.g., wiki DB)
 * so that paused/interrupted sessions can resume without losing access to
 * their profile-specific tools.
 */
export interface SessionToolProvider {
  id: string;
  /** Return tools valid for this session. Called during tool listing for every step. */
  getTools(sessionId: string): RegisteredTool[];
  /** Return hooks valid for this session. Called during tool execution. */
  getHooks(sessionId: string): ToolHook[];
}

export interface StructuredToolCall {
  id: string;
  toolId: string;
  args: Record<string, unknown>;
  reason?: string;
}

export interface LoopModelStep {
  thought?: string;
  message?: string;
  toolCalls: StructuredToolCall[];
  final: boolean;
  stopReason?: string | null;
  finishReason?: string | null;
  usage?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}

export interface LoopStepModelResult {
  step: LoopModelStep;
  model: string | null;
}

export type LoopModelStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thought_delta'; delta: string }
  | { type: 'context_compacted'; originalTokens: number; compressedTokens: number; messageCount: number }
  | { type: 'step_complete'; step: LoopModelStep; model: string | null };

export interface CompactionConfig {
  enabled: boolean;
  threshold: number;
  preserveRecentMessages: number;
  summaryModel?: string;
  maxSummaryTokens: number;
}

export interface CompactionRecord {
  id: string;
  sessionId: string;
  runId: string | null;
  summaryText: string;
  compressedMessageCount: number;
  originalTokenCount: number;
  compressedTokenCount: number;
  createdAt: string;
}

export type AgentRunStreamChunk =
  | { type: 'run_started'; run: AgentRun; event?: RuntimeEvent }
  | { type: 'step_started'; step: AgentRunStep; event?: RuntimeEvent }
  | { type: 'message_delta'; runId: string; stepId: string; delta: string; event?: RuntimeEvent }
  | { type: 'thought_delta'; runId: string; stepId: string; delta: string; event?: RuntimeEvent }
  | { type: 'tool_call'; runId: string; stepId: string; toolCall: ToolCallRecord; event?: RuntimeEvent }
  | { type: 'tool_result'; runId: string; stepId: string; toolCall: ToolCallRecord; event?: RuntimeEvent }
  | { type: 'permission_requested'; runId: string; stepId: string; permission: PermissionDecision; toolCall: ToolCallRecord; event?: RuntimeEvent }
  | { type: 'run_resumed'; run: AgentRun; event?: RuntimeEvent }
  | { type: 'message'; message: AgentRuntimeMessage }
  | { type: 'input_injected'; message: AgentRuntimeMessage; queueItemId: string }
  | { type: 'event'; event: RuntimeEvent }
  | { type: 'run_completed'; run: AgentRun; message?: AgentRuntimeMessage; event?: RuntimeEvent }
  | { type: 'context_compacted'; runId: string; stepId: string; originalTokens: number; compressedTokens: number; messageCount: number; event?: RuntimeEvent }
  | { type: 'run_failed'; run: AgentRun; error: string; event?: RuntimeEvent }
  | { type: 'done'; sessionId: string; runId: string };
