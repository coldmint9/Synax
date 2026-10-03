import type { GitHistoryRef } from "./git-history-contracts.js";
export interface GitEpic {
  id: string;
  projectId: string;
  rootId: string;
  name: string;
  description: string;
  refs: string[];
  sessionIds: string[];
  archived: boolean;
  version: number;
}
export interface GitLinkedSession { id: string; title: string; status: string }
export interface GitBranchLinks {
  ref: string;
  sessions: GitLinkedSession[];
  epicIds: string[];
}
export interface GitAssociations {
  epics: GitEpic[];
  branches: GitBranchLinks[];
  refs: GitHistoryRef[];
  sessions: GitLinkedSession[];
}
