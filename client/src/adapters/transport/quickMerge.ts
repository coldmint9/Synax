import { apiRequest } from "./origin";
import type {
  QuickMergeBoard,
  QuickMergeGroup,
  QuickMergeRule,
  QuickMergeRuleInput,
  QuickMergeRuleView,
} from "../../../../services/local-node/modules/git-quick-merge/contracts";

export type {
  QuickMergeBoard,
  QuickMergeGroup,
  QuickMergeRule,
  QuickMergeRuleView,
  QuickMergeStatus,
  QuickMergeStep,
} from "../../../../services/local-node/modules/git-quick-merge/contracts";

const base = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/git/quick-merge`;
const json = (body: unknown, method = "POST") => ({
  method,
  body: JSON.stringify(body),
  silent: true,
});

export const quickMergeApi = {
  board: (projectId: string, signal?: AbortSignal) =>
    apiRequest<QuickMergeBoard>(base(projectId), { silent: true, signal }),
  createGroup: (projectId: string, input: { name: string; rootId?: string }) =>
    apiRequest<QuickMergeGroup>(`${base(projectId)}/groups`, json(input)),
  renameGroup: (projectId: string, groupId: string, name: string) =>
    apiRequest<QuickMergeGroup>(
      `${base(projectId)}/groups/${encodeURIComponent(groupId)}`,
      json({ name }, "PATCH"),
    ),
  deleteGroup: (projectId: string, groupId: string) =>
    apiRequest<void>(`${base(projectId)}/groups/${encodeURIComponent(groupId)}`, {
      method: "DELETE",
      silent: true,
    }),
  createRule: (projectId: string, input: QuickMergeRuleInput) =>
    apiRequest<QuickMergeRule>(`${base(projectId)}/rules`, json(input)),
  updateRule: (
    projectId: string,
    ruleId: string,
    input: { source: string; target: string },
  ) =>
    apiRequest<QuickMergeRule>(
      `${base(projectId)}/rules/${encodeURIComponent(ruleId)}`,
      json(input, "PUT"),
    ),
  deleteRule: (projectId: string, ruleId: string) =>
    apiRequest<void>(`${base(projectId)}/rules/${encodeURIComponent(ruleId)}`, {
      method: "DELETE",
      silent: true,
    }),
  merge: (projectId: string, ruleId: string, rootId?: string) =>
    apiRequest<QuickMergeRuleView>(
      `${base(projectId)}/rules/${encodeURIComponent(ruleId)}/merge`,
      json({ rootId }),
    ),
  push: (projectId: string, ruleId: string, rootId?: string) =>
    apiRequest<QuickMergeRuleView>(
      `${base(projectId)}/rules/${encodeURIComponent(ruleId)}/push`,
      json({ rootId }),
    ),
};
