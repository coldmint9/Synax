import { useAgentSessionStore } from "./state/agentSessionStore";
import { useSessionWorkspaceStore } from "./state/sessionWorkspaceStore";

export interface FileMutationRequest {
  sessionId: string;
  rootId?: string;
  path: string;
  kind: "rename" | "trash";
}

const ACTIVE = new Set(["queued", "running", "stopping", "waiting_permission", "waiting_input"]);

export function fileMutationBlockReason(sessionId: string, rootId: string | undefined, path: string): "running" | "unsaved" | null {
  const sessions = useAgentSessionStore.getState().sessions;
  const session = sessions.find((item) => item.id === sessionId);
  const ancestors = new Set([sessionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of sessions) {
      if (!candidate.parentSessionId || !ancestors.has(candidate.parentSessionId) || ancestors.has(candidate.id)) continue;
      ancestors.add(candidate.id);
      changed = true;
    }
  }
  if (sessions.some((candidate) => ancestors.has(candidate.id) && ACTIVE.has(candidate.status))) return "running";
  const ownerRootId = rootId ?? session?.projectId;
  // A different conversation may have this same workspace member open as well.
  const workspaces = Object.entries(useSessionWorkspaceStore.getState().sessions);
  if (workspaces.some(([otherSessionId, workspace]) => workspace.tabs.some((tab) => {
    const otherProjectId = sessions.find((item) => item.id === otherSessionId)?.projectId;
    return tab.dirty && (tab.rootId ?? otherProjectId) === ownerRootId && tab.path === path;
  }))) return "unsaved";
  return null;
}

export function requestFileMutation(request: FileMutationRequest): void {
  document.dispatchEvent(new CustomEvent<FileMutationRequest>("workspace:file-mutation", { detail: request }));
}
