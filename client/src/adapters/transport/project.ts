import type { ProjectSummary } from "../../shared/state/shellStore";
import { addProject } from "../../shared/state/shellStore";
import type {
  CreateProjectFromRepoRequest,
  CreateProjectFromScratchRequest,
} from "../../shared/contracts/project";
import { apiFetch } from "./origin";
import {
  listProjects,
  mapToProjectSummary,
} from "./project-list";

const API_BASE = "/api/projects";

export type WorkspaceLocation =
  | { kind: "host"; path: string }
  | { kind: "wsl"; distribution: string; path: string };

export interface DuplicateCheckResult {
  exists: boolean;
  existingId?: string;
  existingName?: string;
  reason?: string;
}

export interface DeleteResult {
  ok: boolean;
  gitCleaned?: boolean;
  gitCleanError?: string;
  backupFile?: string;
}

export interface ProjectStats {
  sessionCount: number;
  nodeCount: number;
  recentRunCount: number;
  lastActivity: string | null;
}


export interface ProjectWorkspaceRoot {
  id: string;
  name: string;
  path: string;
  role: "primary" | "reference";
  status: "available" | "missing";
  location?: WorkspaceLocation;
}

export interface ProjectWorkspace {
  roots: ProjectWorkspaceRoot[];
}

export type AddProjectReferenceRequest =
  | {
      name?: string;
      location: WorkspaceLocation;
      projectId?: never;
      localPath?: never;
    }
  | { name?: string; localPath: string; projectId?: never; location?: never }
  | { projectId: string; name?: never; localPath?: never; location?: never };

export interface GitBranchSummary {
  name: string;
  head: string;
  upstream: string | null;
  checkedOutPath: string | null;
}

export interface GitWorktreeSummary {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  primary: boolean;
  locked: boolean;
  prunable: boolean;
  managed: boolean;
  dirty: boolean;
  sessionCount: number;
  activeSessionCount?: number;
  statusKnown?: boolean;
}

export interface GitCommitSummary {
  id: string;
  parents: string[];
  subject: string;
  author: string;
  authoredAt: string;
  refs: string[];
  rebase: boolean;
}

export interface GitWorkspaceSummary {
  repositoryRoot: string;
  defaultPath: string;
  branches: GitBranchSummary[];
  commits: GitCommitSummary[];
  worktrees: GitWorktreeSummary[];
}
export type { GitHistoryPage, GitHistoryRef, GitCommitDetail } from "../../../../services/local-node/modules/git-history-contracts";

async function projectRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(url, init);
  if (!resp.ok) {
    const body = (await resp
      .json()
      .catch(() => ({ error: resp.statusText }))) as { error?: string };
    throw new Error(body.error || `HTTP ${resp.status}`);
  }
  return (await resp.json()) as T;
}

export const projectApi = {
  previewGitWorktree(id: string, branch: string, rootId?: string): Promise<{ path: string }> {
    const query = new URLSearchParams({ branch });
    if (rootId) query.set("rootId", rootId);
    return projectRequest(`${API_BASE}/${encodeURIComponent(id)}/git/worktrees/preview?${query}`);
  },
  previewGitWorktreeCleanup(id: string, rootId?: string): Promise<import("../../../../services/local-node/modules/git-worktree-management-contracts").GitWorktreeCleanupPreview> {
    const query = new URLSearchParams(rootId ? { rootId } : {});
    return projectRequest(`${API_BASE}/${encodeURIComponent(id)}/git/worktrees/cleanup?${query}`);
  },
  cleanupGitWorktrees(id: string, paths: string[], rootId?: string): Promise<import("../../../../services/local-node/modules/git-worktree-management-contracts").GitWorktreeCleanupResponse> {
    return projectRequest(`${API_BASE}/${encodeURIComponent(id)}/git/worktrees/cleanup`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths, rootId }),
    });
  },
  previewGitWorktreePrune(id: string, rootId?: string): Promise<{ paths: string[] }> {
    const query = new URLSearchParams(rootId ? { rootId } : {});
    return projectRequest(`${API_BASE}/${encodeURIComponent(id)}/git/worktrees/prune?${query}`);
  },
  async createWorkspace(body: {
    name: string;
    roots: (
      | { location: WorkspaceLocation; name?: string }
      | { localPath: string; name?: string }
      | { projectId: string }
    )[];
  }): Promise<{ project: ProjectSummary }> {
    const result = await projectRequest<{ project: Record<string, unknown> }>(
      `${API_BASE}/workspaces`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const project = mapToProjectSummary(result.project);
    addProject(project);
    return { project };
  },
  getWorkspace(id: string): Promise<ProjectWorkspace> {
    return projectRequest(`${API_BASE}/${encodeURIComponent(id)}/workspace`);
  },

  addReference(
    id: string,
    body: AddProjectReferenceRequest,
  ): Promise<ProjectWorkspace> {
    return projectRequest(`${API_BASE}/${encodeURIComponent(id)}/references`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  removeReference(id: string, referenceId: string): Promise<ProjectWorkspace> {
    return projectRequest(
      `${API_BASE}/${encodeURIComponent(id)}/references/${encodeURIComponent(referenceId)}`,
      {
        method: "DELETE",
      },
    );
  },

  listGitWorkspaces(id: string, rootId?: string): Promise<GitWorkspaceSummary> {
    return projectRequest(
      `${API_BASE}/${encodeURIComponent(id)}/git/workspaces${rootId ? `?rootId=${encodeURIComponent(rootId)}` : ""}`,
    );
  },
  gitHistory(id: string, input: { rootId?: string; offset?: number; limit?: number; snapshot?: string } = {}): Promise<import("../../../../services/local-node/modules/git-history-contracts").GitHistoryPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) if (value !== undefined) query.set(key, String(value));
    return projectRequest(`/api/projects/${encodeURIComponent(id)}/git/history?${query}`);
  },
  gitCommit(id: string, sha: string, rootId?: string): Promise<import("../../../../services/local-node/modules/git-history-contracts").GitCommitDetail> {
    const query = rootId ? `?rootId=${encodeURIComponent(rootId)}` : "";
    return projectRequest(`/api/projects/${encodeURIComponent(id)}/git/commits/${encodeURIComponent(sha)}${query}`);
  },
  gitAction(id: string, input: import("../../../../services/local-node/modules/git-history-contracts").GitActionInput & { rootId?: string }): Promise<import("../../../../services/local-node/modules/git-history-contracts").GitActionResult> {
    return projectRequest(`/api/projects/${encodeURIComponent(id)}/git/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  },
  gitAssociations(id: string, rootId?: string): Promise<import("../../../../services/local-node/modules/git-epic-contracts").GitAssociations> {
    return projectRequest(`/api/projects/${encodeURIComponent(id)}/git/associations${rootId ? `?rootId=${encodeURIComponent(rootId)}` : ""}`);
  },
  gitState(id: string, rootId?: string): Promise<import("../../../../services/local-node/modules/git-history-contracts").GitActionResult> {
    return projectRequest(`/api/projects/${encodeURIComponent(id)}/git/state${rootId ? `?rootId=${encodeURIComponent(rootId)}` : ""}`);
  },
  gitConflict(id: string, path: string, rootId?: string): Promise<import("../../../../services/local-node/modules/git-mr/contracts").MergeFile> {
    const query = new URLSearchParams({ path, ...(rootId ? { rootId } : {}) });
    return projectRequest(`/api/projects/${encodeURIComponent(id)}/git/conflict?${query}`);
  },
  saveGitConflict(id: string, path: string, input: import("../../../../services/local-node/modules/git-mr/contracts").MergeFileSave, rootId?: string): Promise<import("../../../../services/local-node/modules/git-mr/contracts").MergeFile> {
    return projectRequest(`/api/projects/${encodeURIComponent(id)}/git/conflict`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, path, rootId }) });
  },
  saveGitEpic(id: string, input: Omit<import("../../../../services/local-node/modules/git-epic-contracts").GitEpic, "id" | "projectId" | "rootId" | "version"> & { rootId?: string; id?: string; expectedVersion?: number }): Promise<import("../../../../services/local-node/modules/git-epic-contracts").GitEpic> {
    return projectRequest(`/api/projects/${encodeURIComponent(id)}/git/epics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  },

  createGitWorktree(
    id: string,
    body: {
      branch: string;
      createBranch?: boolean;
      startPoint?: string;
      rootId?: string;
    },
  ): Promise<{ worktree: GitWorktreeSummary }> {
    return projectRequest(
      `${API_BASE}/${encodeURIComponent(id)}/git/worktrees`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  },

  removeGitWorktree(
    id: string,
    body: { path: string; force?: boolean; rootId?: string },
  ): Promise<{ removed: true }> {
    return projectRequest(
      `${API_BASE}/${encodeURIComponent(id)}/git/worktrees`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  },

  pruneGitWorktrees(id: string, rootId?: string, paths: string[] = []): Promise<GitWorkspaceSummary> {
    return projectRequest(
      `${API_BASE}/${encodeURIComponent(id)}/git/worktrees/prune${rootId ? `?rootId=${encodeURIComponent(rootId)}` : ""}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rootId, paths }) },
    );
  },

  /** List all projects from backend with optional search/filter/sort */
  listProjects,

  /** Get a single project by ID */
  async getProject(id: string): Promise<ProjectSummary | null> {
    try {
      const resp = await apiFetch(`${API_BASE}/${id}`);
      if (!resp.ok) return null;
      const p = (await resp.json()) as Record<string, unknown>;
      return mapToProjectSummary(p);
    } catch {
      return null;
    }
  },

  /** Check if a project with the same source already exists */
  async checkDuplicate(
    kind: string,
    repoUrl?: string,
    localPath?: string,
  ): Promise<DuplicateCheckResult> {
    try {
      const resp = await apiFetch(`${API_BASE}/check-duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, repoUrl, localPath }),
      });
      if (!resp.ok) return { exists: false };
      return (await resp.json()) as DuplicateCheckResult;
    } catch {
      return { exists: false };
    }
  },

  /** Create project via backend */
  async createProject(payload: {
    name: string;
    environment: string;
    source: {
      kind: string;
      repoUrl?: string;
      branch?: string;
      commitSha?: string;
      localPath?: string;
      provider?: string;
    };
    overwriteExisting?: boolean;
  }): Promise<{ project: ProjectSummary }> {
    const resp = await apiFetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }));
      if (resp.status === 409 && body.duplicate) {
        const err = new Error(
          body.duplicate.reason || "Duplicate project source detected",
        ) as Error & { duplicate: Record<string, unknown>; code: string };
        err.duplicate = body.duplicate;
        err.code = body.code || "DUPLICATE_SOURCE";
        throw err;
      }
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const p = data.project;
    const project = mapToProjectSummary(p);
    addProject(project);
    return { project };
  },

  /** Update project fields */
  async updateProject(
    id: string,
    payload: {
      name?: string;
      environment?: string;
      status?: string;
      healthScore?: number;
      importState?: string;
      importError?: string;
      activeAgents?: number;
      activeHumans?: number;
      openRisks?: number;
    },
  ): Promise<ProjectSummary> {
    const resp = await apiFetch(`${API_BASE}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    const p = (await resp.json()) as Record<string, unknown>;
    return mapToProjectSummary(p);
  },

  /** Delete project */
  async deleteProject(id: string): Promise<DeleteResult> {
    const resp = await apiFetch(`${API_BASE}/${id}`, { method: "DELETE" });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    return (await resp.json()) as DeleteResult;
  },

  /** Get real-time project stats */
  async getProjectStats(id: string): Promise<ProjectStats | null> {
    try {
      const resp = await apiFetch(`${API_BASE}/${id}/stats`);
      if (!resp.ok) return null;
      return (await resp.json()) as ProjectStats;
    } catch {
      return null;
    }
  },

  // Legacy helper methods
  async createFromScratch(
    payload: CreateProjectFromScratchRequest,
    _operator: string,
  ): Promise<{ project: ProjectSummary }> {
    return projectApi.createProject({
      name: payload.name,
      environment: payload.environment,
      source: { kind: "scratch" },
    });
  },

  async createFromRepo(
    payload: CreateProjectFromRepoRequest,
    _operator: string,
  ): Promise<{ project: ProjectSummary }> {
    return projectApi.createProject({
      name: payload.name,
      environment: payload.environment,
      source: {
        kind: "git",
        repoUrl: `https://github.com/${payload.repoFullName}.git`,
        branch: payload.branch,
      },
    });
  },
};
