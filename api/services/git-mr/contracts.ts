/** Public local-MR wire types. No runtime or Node dependencies. */
export type MergeStrategy = "merge_commit" | "squash" | "ff_only";
export type MergeStatus =
  | "draft"
  | "preparing"
  | "conflicted"
  | "ready"
  | "checking"
  | "check_failed"
  | "applying"
  | "merged"
  | "noop"
  | "cancelled"
  | "failed"
  | "interrupted";
export interface MergeCheckConfig {
  id: string;
  executable: string;
  args: string[];
  timeoutMs: number;
}
export interface MergeCheckResult {
  id: string;
  status: "passed" | "failed";
  output: string;
  tree: string;
  finishedAt: string;
}
export interface MergeStep {
  branch: string;
  oid: string;
  status: "pending" | "merging" | "conflicted" | "completed" | "noop";
  inputOid?: string;
  outputOid?: string;
}
export interface MergeRequestInput {
  rootId?: string;
  title: string;
  target: string;
  sources: string[];
  strategy: MergeStrategy;
  checks?: MergeCheckConfig[];
  autoFinalize?: boolean;
  allowCheckedOutTarget?: boolean;
}
export interface MergeRequest {
  id: string;
  projectId: string;
  rootId?: string;
  title: string;
  target: string;
  targetOid: string;
  strategy: MergeStrategy;
  steps: MergeStep[];
  status: MergeStatus;
  version: number;
  currentStep: number;
  candidateOid?: string;
  candidateTree?: string;
  worktree?: string;
  repository: string;
  commonDir: string;
  location?:
    | { kind: "host"; path: string }
    | { kind: "wsl"; distribution: string; path: string };
  createdAt: string;
  updatedAt: string;
  checks: MergeCheckConfig[];
  checkResults: MergeCheckResult[];
  autoFinalize: boolean;
  allowCheckedOutTarget: boolean;
  error?: string;
  events: { at: string; message: string }[];
  agentSessionId?: string;
  application?: { candidateOid: string; targetOid: string; startedAt: string };
}
export interface MergeFile {
  id: string;
  path: string;
  status: string;
  conflicted: boolean;
  kind: "text" | "binary" | "structural";
  base: string;
  target: string;
  source: string;
  result: string;
  revision: string;
  baseExists: boolean;
  targetExists: boolean;
  sourceExists: boolean;
  reason?: string;
  resolutionState?: unknown;
  targetLabel?: string;
  sourceLabel?: string;
  baseLabel?: string;
}
export interface MergeFileSummary {
  id: string;
  path: string;
  status: string;
  conflicted: boolean;
}
export interface MergeFileSave {
  expectedRevision: string;
  content?: string;
  choice?: "target" | "source" | "delete";
  resolve: boolean;
  resolutionState?: unknown;
}
export interface MergePreset {
  id: string;
  projectId: string;
  name: string;
  version: number;
  input: MergeRequestInput;
  createdAt: string;
}
export interface MergeProposal {
  id: string;
  mrId: string;
  fileId: string;
  revision: string;
  content: string;
  rationale: string;
  createdAt: string;
}

export interface MergeBranchAncestor {
  branch?: string;
  oid?: string;
  evidence: "creation_record" | "merge_base" | "unknown";
}
export type MergeBranchBlockReason =
  | "same_branch"
  | "already_included"
  | "branch_policy"
  | "unrelated_histories"
  | "not_fast_forward"
  | "invalid_queue";
export interface MergeBranchCandidate {
  name: string;
  oid: string;
  ancestor: MergeBranchAncestor;
  mergeBaseOids: string[];
  enabled: boolean;
  reason?: MergeBranchBlockReason;
  detail?: string;
}
export interface MergeBranchOptionsInput {
  rootId?: string;
  target: string;
  strategy: MergeStrategy;
  sources: string[];
}
export interface MergeBranchOptions {
  target: string;
  targetOid: string;
  comparisonBranch: string;
  branches: MergeBranchCandidate[];
  invalidSources: {
    name: string;
    reason: MergeBranchBlockReason;
    detail: string;
  }[];
}
