import { apiRequest } from "./origin";
import type {
  MergeRequest,
  MergeRequestInput,
  MergeFile,
  MergeFileSave,
  MergeFileSummary,
  MergePreset,
  MergeProposal,
  MergeBranchOptions,
  MergeBranchOptionsInput,
} from "../../../../api/services/git-mr/contracts";
export type {
  MergeRequest,
  MergeRequestInput,
  MergeFile,
  MergeFileSave,
  MergeFileSummary,
  MergePreset,
  MergeProposal,
  MergeBranchOptions,
  MergeBranchOptionsInput,
  MergeStatus,
  MergeStrategy,
  MergeCheckConfig,
} from "../../../../api/services/git-mr/contracts";
export type MergeAction =
  | "prepare"
  | "continue"
  | "resume"
  | "checks"
  | "finalize"
  | "cancel";
const base = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/git/mr`;
const item = (projectId: string, id: string) =>
  `${base(projectId)}/${encodeURIComponent(id)}`;
const json = (body: unknown, method = "POST") => ({
  method,
  body: JSON.stringify(body),
  silent: true,
});
export const gitMrApi = {
  branchOptions: (
    projectId: string,
    input: MergeBranchOptionsInput,
    signal?: AbortSignal,
  ) =>
    apiRequest<MergeBranchOptions>(`${base(projectId)}/branch-options`, {
      ...json(input),
      signal,
    }),
  list: (projectId: string) =>
    apiRequest<MergeRequest[]>(base(projectId), { silent: true }),
  create: (projectId: string, input: MergeRequestInput) =>
    apiRequest<MergeRequest>(base(projectId), json(input)),
  get: (projectId: string, id: string) =>
    apiRequest<MergeRequest>(item(projectId, id), { silent: true }),
  action: (
    projectId: string,
    id: string,
    action: MergeAction,
    expectedVersion: number,
  ) =>
    apiRequest<MergeRequest>(
      `${item(projectId, id)}/${action}`,
      json({ expectedVersion }),
    ),
  files: (projectId: string, id: string) =>
    apiRequest<MergeFileSummary[]>(`${item(projectId, id)}/files`, {
      silent: true,
    }),
  file: (projectId: string, id: string, fileId: string) =>
    apiRequest<MergeFile>(
      `${item(projectId, id)}/files/${encodeURIComponent(fileId)}`,
      { silent: true },
    ),
  saveFile: (
    projectId: string,
    id: string,
    fileId: string,
    input: MergeFileSave,
  ) =>
    apiRequest<MergeFile>(
      `${item(projectId, id)}/files/${encodeURIComponent(fileId)}`,
      json(input, "PUT"),
    ),
  presets: (projectId: string) =>
    apiRequest<MergePreset[]>(`${base(projectId)}/presets`, { silent: true }),
  savePreset: (projectId: string, name: string, input: MergeRequestInput) =>
    apiRequest<MergePreset>(
      `${base(projectId)}/presets`,
      json({ name, input }),
    ),
  deletePreset: (projectId: string, presetId: string) =>
    apiRequest<{ ok: boolean }>(
      `${base(projectId)}/presets/${encodeURIComponent(presetId)}`,
      { method: "DELETE", silent: true },
    ),
  runPreset: (projectId: string, presetId: string) =>
    apiRequest<MergeRequest>(
      `${base(projectId)}/presets/${encodeURIComponent(presetId)}/run`,
      json({}),
    ),
  agentSession: (projectId: string, id: string) =>
    apiRequest<{ sessionId: string }>(
      `${item(projectId, id)}/agent-session`,
      json({}),
    ),
  proposals: (projectId: string, id: string) =>
    apiRequest<MergeProposal[]>(`${item(projectId, id)}/proposals`, {
      silent: true,
    }),
  applyProposal: (
    projectId: string,
    id: string,
    proposalId: string,
    expectedVersion: number,
  ) =>
    apiRequest<MergeFile>(
      `${item(projectId, id)}/proposals/${encodeURIComponent(proposalId)}/apply`,
      json({ expectedVersion }),
    ),
};
