import { apiRequest } from "./origin";
import type {
  ConversationGitAction,
  ConversationGitApplyProposal,
  ConversationGitCreate,
  ConversationGitSave,
  ConversationGitSnapshot,
} from "../../../../services/local-node/modules/agent-runtime/conversation-git/contracts";
import type { MergeFile } from "./gitMr";
import type { MergeFileSlice, MergeFileSliceInput } from "../../../../services/local-node/modules/git-mr/contracts";

export type {
  ConversationGitReference,
  ConversationGitTask,
  ConversationGitCommit,
  ConversationGitSnapshot,
  ConversationGitAction,
  ConversationGitActionName,
  ConversationGitCreate,
  ConversationGitSave,
  ConversationGitApplyProposal,
} from "../../../../services/local-node/modules/agent-runtime/conversation-git/contracts";

const base = (sessionId: string) =>
  `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/git-tasks`;
const item = (sessionId: string, objectId: string) =>
  `${base(sessionId)}/${encodeURIComponent(objectId)}`;
const json = (body: unknown, method = "POST") => ({
  method,
  body: JSON.stringify(body),
  silent: true,
});

/** Session-bound native actions. Generated HTML never gets this transport. */
export const conversationGitApi = {
  list: (sessionId: string, signal?: AbortSignal) =>
    apiRequest<ConversationGitSnapshot[]>(base(sessionId), {
      silent: true,
      signal,
    }),
  create: (sessionId: string, input: ConversationGitCreate) =>
    apiRequest<ConversationGitSnapshot>(
      `${base(sessionId)}/create`,
      json(input),
    ),
  get: (sessionId: string, objectId: string, signal?: AbortSignal) =>
    apiRequest<ConversationGitSnapshot>(item(sessionId, objectId), {
      silent: true,
      signal,
    }),
  file: (
    sessionId: string,
    objectId: string,
    fileId: string,
    signal?: AbortSignal,
  ) =>
    apiRequest<MergeFile>(
      `${item(sessionId, objectId)}/files/${encodeURIComponent(fileId)}`,
      { silent: true, signal },
    ),
  fileSlice: (sessionId: string, objectId: string, fileId: string, input: MergeFileSliceInput, signal?: AbortSignal) => {
    const query = new URLSearchParams({ side: input.side, byteOffset: String(input.byteOffset), maxBytes: String(input.maxBytes), expectedRevision: input.expectedRevision });
    return apiRequest<MergeFileSlice>(`${item(sessionId, objectId)}/files/${encodeURIComponent(fileId)}/content?${query}`, { silent: true, signal });
  },
  action: (sessionId: string, objectId: string, input: ConversationGitAction) =>
    apiRequest<ConversationGitSnapshot>(
      `${item(sessionId, objectId)}/actions`,
      json(input),
    ),
  saveFile: (
    sessionId: string,
    objectId: string,
    fileId: string,
    input: ConversationGitSave,
  ) =>
    apiRequest<ConversationGitSnapshot>(
      `${item(sessionId, objectId)}/files/${encodeURIComponent(fileId)}`,
      json(input, "PUT"),
    ),
  applyProposal: (
    sessionId: string,
    objectId: string,
    input: ConversationGitApplyProposal,
  ) =>
    apiRequest<ConversationGitSnapshot>(
      `${item(sessionId, objectId)}/proposals/apply`,
      json(input),
    ),
};
