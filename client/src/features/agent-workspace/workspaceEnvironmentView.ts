import type {
  SessionEnvironmentFile,
  SessionEnvironmentInputSource,
  SessionEnvironmentInputs,
  SessionEnvironmentOutputs,
  SessionEnvironmentRoots,
  SessionEnvironmentSubagent,
  SessionEnvironmentSubagents,
  WorkspaceRepositoryGit,
} from "../../adapters/transport/agentRuntime";

/**
 * Client-side join of the two environment layers.
 *
 * `repositories` is the session's own workspace binding (which roots exist and
 * where they are) merged with the workspace-level Git facts shared by every
 * session of that workspace. `agentChangedFiles` is derived here as
 * `editedPaths ∩ git changedFiles`, so the server no longer has to compute a
 * per-session Git projection.
 */

export interface WorkspaceEnvironmentRepository {
  rootId: string;
  name: string;
  role: "primary" | "reference";
  status: "ready" | "missing" | "not_repository" | "error";
  workspacePath: string;
  branch: string;
  headCommitSha: string;
  unpushedCommitCount?: number;
  dirty: boolean;
  additions: number;
  deletions: number;
  changedFiles: SessionEnvironmentFile[];
  /** Files this session's agent wrote/edited/deleted and that are still uncommitted. */
  agentChangedFiles: SessionEnvironmentFile[];
  outputFiles: string[];
  inputSources: SessionEnvironmentInputSource[];
}

export interface WorkspaceEnvironmentView extends WorkspaceEnvironmentRepository {
  sessionId: string;
  projectId: string;
  repositories: WorkspaceEnvironmentRepository[];
  subagents: SessionEnvironmentSubagent[];
  refreshedAt: string;
}

export interface WorkspaceEnvironmentInput {
  sessionId: string;
  roots: SessionEnvironmentRoots | null;
  git: { repositories: WorkspaceRepositoryGit[] } | null;
  inputs?: SessionEnvironmentInputs | null;
  outputs?: SessionEnvironmentOutputs | null;
  subagents?: SessionEnvironmentSubagents | null;
}

export function buildWorkspaceEnvironmentView({
  sessionId,
  roots,
  git,
  inputs,
  outputs,
  subagents,
}: WorkspaceEnvironmentInput): WorkspaceEnvironmentView | null {
  const rootList = roots?.repositories ?? [];
  if (rootList.length === 0) return null;
  const factsByRoot = new Map(
    (git?.repositories ?? []).map((facts) => [facts.rootId, facts]),
  );
  const repositories: WorkspaceEnvironmentRepository[] = rootList.map((root) => {
    const candidate = factsByRoot.get(root.rootId);
    // An old Git request must never repaint a newly bound checkout.
    const facts = candidate?.workspacePath === root.workspacePath ? candidate : undefined;
    const edited = new Set(outputs?.editedPathsByRoot[root.rootId] ?? []);
    const changedFiles = facts?.changedFiles ?? [];
    return {
      rootId: root.rootId,
      name: root.name,
      role: root.role,
      status: facts?.status ?? root.status,
      workspacePath: facts?.workspacePath ?? root.workspacePath,
      branch: facts?.branch ?? "",
      headCommitSha: facts?.headCommitSha ?? "",
      unpushedCommitCount: facts?.unpushedCommitCount ?? 0,
      dirty: facts?.dirty ?? false,
      additions: facts?.additions ?? 0,
      deletions: facts?.deletions ?? 0,
      changedFiles,
      agentChangedFiles: changedFiles.filter((file) => edited.has(file.path)),
      outputFiles: outputs?.byRoot[root.rootId] ?? [],
      inputSources: inputs?.byRoot[root.rootId] ?? [],
    };
  });
  const primary =
    repositories.find((repository) => repository.role === "primary") ??
    repositories[0];
  return {
    ...primary,
    sessionId: roots?.sessionId ?? sessionId,
    projectId: roots?.projectId ?? "",
    repositories,
    subagents: subagents?.subagents ?? [],
    refreshedAt: roots?.refreshedAt ?? "",
  };
}
