/** Persisted conversation references and native renderer data; no runtime dependencies. */
import type { MergeRequest, MergeRequestInput, MergeFileSummary, MergeProposal, MergeFileSave, MergeStatus } from '../../git-mr/contracts.js';
export type ConversationMergeExecutionStatus = 'queued' | 'running' | 'pausing' | 'paused' | 'waiting_user' | 'cancelling' | 'cancelled' | 'cancelled_cleanup_pending' | 'completed' | 'failed' | 'recovery_required';
export interface ConversationMergeExecution {
  status: ConversationMergeExecutionStatus;
  phase: 'preparing' | 'resolving' | 'checking' | 'applying' | 'settled';
  childSessionId?: string;
  joinMode: 'blocking' | 'async';
  revision: number;
  epoch: number;
  summary?: string;
  error?: string;
  updatedAt: string;
}
/** Small invalidation/projection event. File bodies and child transcripts never travel here. */
export interface ConversationGitStateEvent {
  type: 'conversation_git_state';
  taskId: string;
  taskRevision: number;
  mrVersion: number;
  status: MergeStatus;
  execution?: ConversationMergeExecution;
  files?: MergeFileSummary[];
  changedFileIds?: string[];
  changedFiles?: MergeFileSummary[];
  filesRevision?: number;
  summary?: string;
  eventSeq: number;
}
export type ConversationGitState = Omit<ConversationGitStateEvent, 'type'>;
export interface ConversationGitMessage {
  id: string;
  sessionId: string;
  runId: string | null;
  stepId: string | null;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationGitReference {
  schema: 'synax.git-merge';
  schemaVersion: 1;
  objectId: string;
  sessionId: string;
  projectId: string;
  rootId?: string;
  title: string;
}
export interface ConversationGitTask {
  id: string;
  sessionId: string;
  projectId: string;
  rootId?: string;
  mrId: string;
  previousMrIds: string[];
  messageId: string;
  createdAt: string;
  updatedAt: string;
  /** Version of the binding; MR.version remains the Git execution concurrency token. */
  revision: number;
}
export interface ConversationGitCommit {
  oid: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  refs: string[];
}
export interface ConversationGitSnapshot {
  task: ConversationGitTask;
  reference: ConversationGitReference;
  mr: MergeRequest;
  files: MergeFileSummary[];
  proposals: MergeProposal[];
  commits: ConversationGitCommit[];
  stale: boolean;
  staleReason?: string;
  /** Persisted anchor / receipts, returned for Rust-backed clients to upsert immediately. */
  messages: ConversationGitMessage[];
  execution?: ConversationMergeExecution;
}
export type ConversationGitCreate = Omit<MergeRequestInput, 'autoFinalize'> & { requestId: string };
export type ConversationGitActionName = 'prepare' | 'continue' | 'checks' | 'finalize' | 'cancel' | 'pause' | 'resume' | 'replan';
export interface ConversationGitAction {
  action: ConversationGitActionName;
  /** Explicit human decision; valid only with finalize. */
  skipChecks?: boolean;
  requestId: string;
  expectedVersion: number;
  expectedTaskRevision: number;
}
export interface ConversationGitSave extends MergeFileSave {
  requestId: string;
  expectedVersion: number;
  expectedTaskRevision: number;
}
export interface ConversationGitApplyProposal {
  proposalId: string;
  requestId: string;
  expectedVersion: number;
  expectedTaskRevision: number;
}
