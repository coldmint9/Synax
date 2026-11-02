import type { RefObject } from "react";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { useTranscriptRenderPending } from "./useTranscriptRenderPending";

/**
 * Whether the workspace the reader just switched to has finished loading.
 *
 * A workspace switch is four asynchronous steps: the route changes, the store
 * rebinds `projectId`, the session list arrives, and the last visit reopens a
 * conversation (whose history then loads). The transition must not clear on
 * the first of them, so every step is part of this answer.
 *
 * `routeSessionId` is the conversation the URL asks for — `null` on the
 * new-session scene and while the route is still bare. `routeSettled` tells
 * whether the URL has reached its final shape; until then the list is not the
 * thing being waited on.
 */
export function useWorkspaceSwitchReadiness(
  root: RefObject<HTMLElement | null>,
  projectId: string,
  routeSessionId: string | null,
  routeSettled: boolean,
): boolean {
  const boundProjectId = useAgentSessionStore((state) => state.projectId);
  const listLoading = useAgentSessionStore((state) => state.sessionListLoading);
  const listLoadedAt = useAgentSessionStore((state) => state.sessionListLoadedAt);
  const detailLoading = useAgentSessionStore((state) => state.detailLoading);
  const detailRefreshing = useAgentSessionStore((state) => state.detailRefreshing);
  const selectedSessionId = useAgentSessionStore((state) => state.selectedSessionId);
  // Records of the conversation being restored mount asynchronously; the
  // switch reads the same readiness signal the session switch uses. The key
  // includes the conversation because a workspace switch opens it after the
  // route resolves — that commit, not the route change, is the one whose rows
  // have to be mounted.
  const renderKey = projectId
    ? `${projectId}:${selectedSessionId ?? ""}`
    : null;
  const renderPending = useTranscriptRenderPending(
    root,
    renderKey,
    Boolean(projectId),
  );

  if (!projectId || boundProjectId !== projectId) return false;
  if (!routeSettled) return false;
  if (listLoading || listLoadedAt <= 0) return false;
  if (routeSessionId && selectedSessionId !== routeSessionId) return false;
  if (detailLoading || detailRefreshing) return false;
  return !renderPending;
}
