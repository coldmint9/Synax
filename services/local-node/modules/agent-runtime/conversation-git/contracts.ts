/** Persisted conversation references and native renderer data; no runtime dependencies. */
import type { MergeRequest, MergeRequestInput, MergeFileSummary, MergeProposal, MergeFileSave } from '../../git-mr/contracts.js';
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
}
export type ConversationGitCreate = Omit<MergeRequestInput, 'autoFinalize'> & { requestId: string };
export type ConversationGitActionName = 'prepare' | 'continue' | 'checks' | 'finalize' | 'cancel' | 'resume' | 'replan';
export interface ConversationGitAction {
  action: ConversationGitActionName;
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
