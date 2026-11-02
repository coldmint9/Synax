/** Quick-merge wire types. No runtime dependencies. */
export type QuickMergeStatus =
  | "idle"
  | "merged"
  | "pushed"
  | "conflicted"
  | "failed";

export interface QuickMergeGroup {
  id: string;
  projectId: string;
  rootId?: string;
  name: string;
  order: number;
  createdAt: string;
}

export interface QuickMergeRule {
  id: string;
  projectId: string;
  rootId?: string;
  groupId: string;
  source: string;
  target: string;
  order: number;
  createdAt: string;
  status: QuickMergeStatus;
  /** Last merge request produced by this rule; owns conflict resolution. */
  mrId?: string;
  lastKind?: "merge" | "push";
  lastAt?: string;
  message?: string;
  /** Commits the local target is ahead of its remote after the last run. */
  ahead?: number;
}

export interface QuickMergeStep {
  command: string;
  status: "ok" | "failed" | "skipped";
  detail: string;
}

export interface QuickMergeRuleView extends QuickMergeRule {
  steps?: QuickMergeStep[];
}

export interface QuickMergeBoard {
  groups: QuickMergeGroup[];
  rules: QuickMergeRuleView[];
}

export interface QuickMergeRuleInput {
  rootId?: string;
  groupId: string;
  source: string;
  target: string;
}

export const QUICK_MERGE_KINDS = {
  groups: "quick-groups",
  rules: "quick-rules",
} as const;
