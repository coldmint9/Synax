import { apiRequest } from "./origin";
import type {
  RemotePrScope,
  RemotePrCreate,
  RemotePrAttach,
  RemotePrAction,
  RemotePrDiscovery,
  RemotePullRequest,
  RemotePrSnapshot,
} from "../../../../services/local-node/modules/remote-pr/contracts";
export type * from "../../../../services/local-node/modules/remote-pr/contracts";
const base = (sessionId: string) =>
  `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/git-pr`;
const json = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  silent: true,
});
export const remotePrApi = {
  discover: (sessionId: string, rootId?: string, signal?: AbortSignal) =>
    apiRequest<RemotePrDiscovery>(
      `${base(sessionId)}/discovery${rootId ? `?rootId=${encodeURIComponent(rootId)}` : ""}`,
      { signal, silent: true },
    ),
  list: (
    sessionId: string,
    scope: RemotePrScope,
    page = 1,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({
      remote: scope.remote,
      page: String(page),
      ...(scope.rootId ? { rootId: scope.rootId } : {}),
      ...(scope.provider ? { provider: scope.provider } : {}),
    });
    return apiRequest<{ items: RemotePullRequest[]; hasMore: boolean }>(
      `${base(sessionId)}/requests?${params}`,
      { signal, silent: true },
    );
  },
  create: (sessionId: string, input: RemotePrCreate) =>
    apiRequest<RemotePrSnapshot>(`${base(sessionId)}/create`, json(input)),
  attach: (sessionId: string, input: RemotePrAttach) =>
    apiRequest<RemotePrSnapshot>(`${base(sessionId)}/attach`, json(input)),
  push: (
    sessionId: string,
    input: RemotePrScope & { expectedLocalHead: string; branch: string },
  ) => apiRequest<RemotePrDiscovery>(`${base(sessionId)}/push`, json(input)),
  get: (sessionId: string, objectId: string, signal?: AbortSignal) =>
    apiRequest<RemotePrSnapshot>(
      `${base(sessionId)}/tasks/${encodeURIComponent(objectId)}`,
      { signal, silent: true },
    ),
  action: (sessionId: string, objectId: string, input: RemotePrAction) =>
    apiRequest<RemotePrSnapshot>(
      `${base(sessionId)}/tasks/${encodeURIComponent(objectId)}/actions`,
      json(input),
    ),
};
