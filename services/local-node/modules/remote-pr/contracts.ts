import type {
  ConversationGitMessage,
  ConversationGitReference,
} from "../agent-runtime/conversation-git/contracts.js";
export type PrProvider = "github" | "gitlab";
export interface RemoteRepository {
  remote: string;
  host: string;
  path: string;
  provider: PrProvider;
}
export interface RemoteChoice {
  name: string;
  host?: string;
  path?: string;
  provider?: PrProvider;
  unsupportedReason?: string;
}
export interface RemotePrCheck {
  name: string;
  status: "pending" | "passed" | "failed" | "unknown";
  url?: string;
}
/** One GitLab pipeline stage; GitHub pipelines are projected as a single stage. */
export interface RemotePrPipelineStage {
  name: string;
  status: RemotePrCheck["status"];
  jobs: { name: string; status: RemotePrCheck["status"]; url?: string }[];
}
export interface RemotePrPipeline {
  id: number;
  stages: RemotePrPipelineStage[];
  url?: string;
}
export interface RemotePrCommit {
  sha: string;
  title: string;
  author: string;
  createdAt: string;
}
export interface RemotePrStats {
  additions: number;
  deletions: number;
  files: number;
}
export interface RemotePrReview {
  required: number;
  approvedBy: string[];
  reviewers: string[];
}
export interface RemotePullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  mergeable: boolean | null;
  mergeStatus: string;
  author: string;
  checks: RemotePrCheck[];
  checksError?: string;
  sameRepository: boolean;
  updatedAt: string;
  createdAt?: string;
  labels?: string[];
  notesCount?: number;
  /** Populated when the platform exposes a pipeline for the head commit. */
  pipeline?: RemotePrPipeline | null;
  /** Bounded commit list of the request, newest first. */
  commits?: RemotePrCommit[];
  stats?: RemotePrStats | null;
  review?: RemotePrReview | null;
  /** Detail cannot be read right now; the card still renders the core state. */
  detailError?: string;
}
export interface RemotePrReference {
  schema: "synax.git-pr";
  schemaVersion: 1;
  objectId: string;
  sessionId: string;
  projectId: string;
  rootId?: string;
  title: string;
}
export interface RemotePrTask {
  id: string;
  sessionId: string;
  projectId: string;
  rootId: string;
  repository: RemoteRepository;
  number: number;
  revision: number;
  messageId: string;
  createdAt: string;
  updatedAt: string;
  resolution?: {
    objectId: string;
    headBranch: string;
    baseBranch: string;
    headSha: string;
    baseSha: string;
  };
}
export interface RemotePrSnapshot {
  task: RemotePrTask;
  reference: RemotePrReference;
  pr: RemotePullRequest;
  local: { branch: string; headSha: string; dirty: boolean };
  messages: ConversationGitMessage[];
  resolutionReference?: ConversationGitReference;
}
export interface RemotePrScope {
  rootId?: string;
  remote: string;
  provider?: PrProvider;
}
export interface RemotePrCreate extends RemotePrScope {
  requestId: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}
export interface RemotePrAttach extends RemotePrScope {
  requestId: string;
  number: number;
}
export interface RemotePrAction {
  requestId: string;
  expectedRevision: number;
  expectedHeadSha: string;
  expectedBaseSha: string;
  action:
    | "update_branch"
    | "merge"
    | "sync_local"
    | "resolve_conflicts"
    | "publish_resolution";
  mergeMethod?: "merge" | "squash" | "rebase";
}
export interface RemotePrDiscovery {
  rootId: string;
  branch: string;
  headSha: string;
  dirty: boolean;
  remotes: RemoteChoice[];
  branches: string[];
}
