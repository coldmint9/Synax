import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useShellStore } from "../../shared/state/shellStore";
import {
  useSessionEnvironmentInputs,
  useSessionEnvironmentOutputs,
  useSessionEnvironmentRoots,
  useSessionEnvironmentSubagents,
} from "./useSessionEnvironment";
import { useWorkspaceGit } from "./workspaceGitStore";
import {
  buildWorkspaceEnvironmentView,
  type WorkspaceEnvironmentView,
} from "./workspaceEnvironmentView";

export interface SessionWorkspaceEnvironmentValue {
  sessionId: string | null;
  projectId: string | null;
  environment: WorkspaceEnvironmentView | null;
  loading: boolean;
  /** Revalidate both layers: workspace Git and every session card. */
  reload: () => Promise<void>;
}

const SessionEnvironmentContext =
  createContext<SessionWorkspaceEnvironmentValue | null>(null);

/**
 * Compose the two environment layers for one session: workspace-level Git
 * facts (shared by every session of the project) and the session's own cards.
 */
export function useWorkspaceEnvironment(
  sessionId: string | null,
  projectId?: string | null,
): SessionWorkspaceEnvironmentValue {
  const shellProjectId = useShellStore((state) => state.currentProjectId);
  const gitScope = projectId ?? shellProjectId ?? null;
  const git = useWorkspaceGit(sessionId ? gitScope : null, sessionId ?? undefined);
  const roots = useSessionEnvironmentRoots(sessionId);
  const subagents = useSessionEnvironmentSubagents(sessionId);
  const inputs = useSessionEnvironmentInputs(sessionId);
  const outputs = useSessionEnvironmentOutputs(sessionId);

  const environment = useMemo(
    () =>
      sessionId
        ? buildWorkspaceEnvironmentView({
            sessionId,
            roots: roots.value,
            git: git.snapshot,
            inputs: inputs.value,
            outputs: outputs.value,
            subagents: subagents.value,
          })
        : null,
    [sessionId, roots.value, git.snapshot, inputs.value, outputs.value, subagents.value],
  );

  const reload = useCallback(async () => {
    await Promise.all([
      git.reload(),
      roots.reload(),
      subagents.reload(),
      inputs.reload(),
      outputs.reload(),
    ]);
  }, [git.reload, roots.reload, subagents.reload, inputs.reload, outputs.reload]);

  return {
    sessionId,
    projectId: environment?.projectId ?? gitScope,
    environment,
    loading:
      roots.loading || subagents.loading || inputs.loading || outputs.loading,
    reload,
  };
}

export function SessionEnvironmentProvider({
  sessionId,
  projectId,
  children,
}: {
  sessionId: string | null;
  projectId?: string | null;
  children: ReactNode;
}) {
  const value = useWorkspaceEnvironment(sessionId, projectId);
  return (
    <SessionEnvironmentContext.Provider value={value}>
      {children}
    </SessionEnvironmentContext.Provider>
  );
}

/**
 * Use the shared workspace provider when one exists, while keeping the
 * standalone hook available for focused component tests and isolated renders.
 */
export function useSessionWorkspaceEnvironment(
  sessionId: string | null,
): SessionWorkspaceEnvironmentValue {
  const provided = useContext(SessionEnvironmentContext);
  const owned = useWorkspaceEnvironment(provided ? null : sessionId);
  return provided ?? owned;
}
