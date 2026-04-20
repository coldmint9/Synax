/**
 * Synapse Core Types
 *
 * Foundation type definitions for the entire system.
 * Inspired by Claude Code's neutral message format and clawspring's event model,
 * extended with Role Slots and project management concepts.
 */

// ─── Identity ─────────────────────────────────────────────────────────────

export type UserId = string
export type AgentId = string
export type RoleSlotId = string
export type TaskId = string
export type ProjectId = string
export type EventId = string

// ─── Role System ──────────────────────────────────────────────────────────

export enum RoleType {
  PM = 'pm',
  Developer = 'developer',
  QA = 'qa',
  Product = 'product',
  Designer = 'designer',
  DevOps = 'devops',
}

export enum OccupantKind {
  Human = 'human',
  Agent = 'agent',
}

export enum SwitchPolicy {
  Manual = 'manual',
  AutoFailover = 'auto_failover',
  Hybrid = 'hybrid',
}

export enum AgentCapabilityLevel {
  Observer = 1,     // Read-only, suggest and notify
  Executor = 2,     // Execute within predefined rules
  Collaborator = 3, // Propose solutions, execute after confirmation
  Autonomous = 4,   // Fully autonomous within authorized scope
}

export interface RoleSlot {
  id: RoleSlotId
  type: RoleType
  occupant: HumanUser | AgentUser
  permissions: Permission[]
  switchPolicy: SwitchPolicy
  capabilityLevel: AgentCapabilityLevel
  failoverTimeoutMs: number
  projectId: ProjectId
}

export interface HumanUser {
  kind: OccupantKind.Human
  id: UserId
  name: string
  email: string
  avatarUrl?: string
}

export interface AgentUser {
  kind: OccupantKind.Agent
  id: AgentId
  name: string
  model: string
  systemPrompt: string
  allowedTools: string[]  // empty = all tools
  capabilityLevel: AgentCapabilityLevel
  source: 'built-in' | 'user' | 'project'
}

// ─── Events ───────────────────────────────────────────────────────────────

export enum EventType {
  // Git events
  CommitPushed = 'git.commit.pushed',
  BranchCreated = 'git.branch.created',
  BranchDeleted = 'git.branch.deleted',
  PrOpened = 'git.pr.opened',
  PrReviewed = 'git.pr.reviewed',
  PrMerged = 'git.pr.merged',
  PrClosed = 'git.pr.closed',

  // Project events
  TaskCreated = 'project.task.created',
  TaskStatusChanged = 'project.task.status_changed',
  TaskAssigned = 'project.task.assigned',
  MilestoneApproaching = 'project.milestone.approaching',
  SprintStarted = 'project.sprint.started',
  SprintCompleted = 'project.sprint.completed',
  BlockerDetected = 'project.blocker.detected',

  // Team events
  MemberAvailable = 'team.member.available',
  MemberUnavailable = 'team.member.unavailable',
  WorkloadThresholdExceeded = 'team.workload.threshold_exceeded',
  RoleSwitched = 'team.role.switched',

  // Agent events
  AgentStarted = 'agent.started',
  AgentCompleted = 'agent.completed',
  AgentToolCall = 'agent.tool_call',
  AgentDecision = 'agent.decision',
  PermissionRequested = 'agent.permission_requested',
  PermissionGranted = 'agent.permission_granted',
  PermissionDenied = 'agent.permission_denied',

  // System events
  CiFailed = 'system.ci.failed',
  CiPassed = 'system.ci.passed',
  DeploySucceeded = 'system.deploy.succeeded',
  DeployFailed = 'system.deploy.failed',
}

export interface SynapseEvent {
  id: EventId
  type: EventType
  timestamp: number
  projectId: ProjectId
  source: RoleSlotId | 'system'
  payload: Record<string, unknown>
}

// ─── Task System ──────────────────────────────────────────────────────────

export enum TaskStatus {
  Backlog = 'backlog',
  Ready = 'ready',
  InProgress = 'in_progress',
  InReview = 'in_review',
  Testing = 'testing',
  Done = 'done',
  Cancelled = 'cancelled',
}

export enum TaskPriority {
  Critical = 'critical',
  High = 'high',
  Medium = 'medium',
  Low = 'low',
}

export interface Task {
  id: TaskId
  projectId: ProjectId
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  assignee: RoleSlotId | null
  milestoneId: string | null
  gitBranch: string | null
  linkedPrs: string[]
  linkedCommits: string[]
  blockedBy: TaskId[]
  blocks: TaskId[]
  labels: string[]
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

// ─── Agent Loop Events ────────────────────────────────────────────────────

export interface TextChunk {
  type: 'text_chunk'
  text: string
}

export interface ThinkingChunk {
  type: 'thinking_chunk'
  text: string
}

export interface ToolStart {
  type: 'tool_start'
  name: string
  inputs: Record<string, unknown>
  toolCallId: string
}

export interface ToolEnd {
  type: 'tool_end'
  name: string
  result: string
  toolCallId: string
  permitted: boolean
}

export interface TurnDone {
  type: 'turn_done'
  inputTokens: number
  outputTokens: number
}

export interface PermissionRequest {
  type: 'permission_request'
  toolName: string
  description: string
  granted: boolean
}

export type AgentEvent =
  | TextChunk
  | ThinkingChunk
  | ToolStart
  | ToolEnd
  | TurnDone
  | PermissionRequest

// ─── Messages ─────────────────────────────────────────────────────────────

export interface UserMessage {
  role: 'user'
  content: string
  images?: string[]
}

export interface AssistantMessage {
  role: 'assistant'
  content: string
  toolCalls?: ToolCall[]
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultMessage {
  role: 'tool'
  toolCallId: string
  name: string
  content: string
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

// ─── Permissions ──────────────────────────────────────────────────────────

export enum PermissionMode {
  Default = 'default',
  AcceptAll = 'accept_all',
  Manual = 'manual',
}

export interface Permission {
  toolName: string
  mode: PermissionMode
  maxCapabilityLevel: AgentCapabilityLevel
}

// ─── Context ──────────────────────────────────────────────────────────────

export interface ProjectContext {
  projectId: ProjectId
  milestones: Milestone[]
  sprintState: SprintState | null
  teamWorkload: WorkloadEntry[]
  repoState: RepoState
  riskRegistry: Risk[]
  recentDecisions: Decision[]
}

export interface Milestone {
  id: string
  name: string
  deadline: number
  completionPercent: number
}

export interface SprintState {
  id: string
  name: string
  startDate: number
  endDate: number
  totalTasks: number
  completedTasks: number
}

export interface WorkloadEntry {
  roleSlotId: RoleSlotId
  activeTaskCount: number
  capacityPercent: number
}

export interface RepoState {
  branch: string
  openPRs: number
  failedChecks: number
  recentCommits: string[]
}

export interface Risk {
  id: string
  description: string
  severity: 'low' | 'medium' | 'high'
  mitigation: string
}

export interface Decision {
  id: string
  description: string
  madeBy: RoleSlotId
  timestamp: number
  rationale: string
}
