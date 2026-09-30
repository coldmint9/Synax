export interface GitHistoryRef {
  name: string;
  fullName: string;
  head: string;
  kind: "local" | "remote" | "tag";
}
export interface GitHistoryCommit {
  id: string;
  parents: string[];
  subject: string;
  author: string;
  authoredAt: string;
  refs: string[];
  rebase: boolean;
}
export interface GitHistoryPage {
  commits: GitHistoryCommit[];
  refs: GitHistoryRef[];
  snapshot: string;
  nextOffset: number | null;
}
export interface GitCommitDetail extends GitHistoryCommit {
  authorEmail: string;
  committer: string;
  committerEmail: string;
  committedAt: string;
  message: string;
  files: { status: string; path: string; previousPath?: string }[];
  diff: string;
}
export type GitHistoryAction = "merge" | "rebase" | "cherry-pick" | "reset" | "fetch" | "track" | "continue" | "abort";
export interface GitActionInput {
  action: GitHistoryAction;
  expectedHead: string;
  target?: string;
  resetMode?: "soft" | "mixed" | "hard";
  branch?: string;
  confirmed?: boolean;
}
export interface GitActionResult {
  head: string;
  branch: string;
  operation: "merge" | "rebase" | "cherry-pick" | null;
  conflicts: string[];
  output: string;
}
