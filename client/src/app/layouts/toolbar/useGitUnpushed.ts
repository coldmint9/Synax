import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  getWorkspaceGitSnapshot,
  loadWorkspaceGit,
  subscribeWorkspaceGit,
} from "../../../features/agent-workspace/workspaceGitStore";

export interface GitUnpushedState {
  readonly count: number;
  /** Committer time of the oldest unpushed commit, ISO when the server knows it. */
  readonly since: string | null;
}

const NOTHING_UNPUSHED: GitUnpushedState = Object.freeze({ count: 0, since: null });

/**
 * Reads the same cache scope the Git panel and composer use: a session may be
 * bound to its own checkout, so the project alone can describe a different
 * branch. The store owns polling; this hook only joins its shared loader once.
 */
export function useGitUnpushed(
  projectId: string | null,
  sessionId?: string | null,
): GitUnpushedState {
  const scope = sessionId ?? undefined;
  const snapshot = useSyncExternalStore(
    subscribeWorkspaceGit,
    () => getWorkspaceGitSnapshot(projectId, scope),
    () => null,
  );

  useEffect(() => {
    if (!projectId) return;
    const load = () => {
      if (document.hidden) return;
      try {
        void loadWorkspaceGit(projectId, { sessionId: scope, maxAgeMs: 30_000 }).catch(() => {});
      } catch {
        // Keep the previous badge; the Git panel retries on its own cadence.
      }
    };
    load();
    // Coming back to the window is when a push or commit made elsewhere lands;
    // the loader skips the request while the cached scope is still fresh.
    document.addEventListener("visibilitychange", load);
    return () => document.removeEventListener("visibilitychange", load);
  }, [projectId, scope]);

  return useMemo(() => {
    // Reference checkouts are read-only context, not the checkout being worked
    // on: only the project's primary root owns the pending-work reminder.
    const primary = (snapshot?.repositories ?? []).find(
      (repository) => repository.role === "primary" && repository.status === "ready",
    );
    const count = primary?.unpushedCommitCount ?? 0;
    if (count <= 0) return NOTHING_UNPUSHED;
    return { count, since: primary?.unpushedSince ?? null };
  }, [snapshot]);
}
