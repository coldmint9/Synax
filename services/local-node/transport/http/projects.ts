import { runtimeFacade } from "../../modules/agent-runtime/sidecar/runtime-facade.js";
import { createGitMrRoutes } from "./git-mr.js";
import { conversationGitSliceSchema } from '../../modules/agent-runtime/conversation-git/schemas.js';
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import path, { basename } from "node:path";
import {
  canonicalWorkspaceDirectory,
  projectSourceLocation,
  projectWorkspaceRoots,
  validateProjectReferenceLocation,
  workspaceRootHostPath,
  workspaceRootLocation,
  type ProjectReference,
} from "../../modules/project-workspace.js";
import {
  canonicalizeWorkspaceLocation,
  physicalLocationKey,
  type WorkspaceLocation,
} from "../../modules/workspace-location.js";
import * as z from "zod/v4";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { logger } from "../../infrastructure/runtime/logger.js";
import { DATA_ROOT } from "../../infrastructure/runtime/env.js";
import { initializeProjectSettings } from "../../infrastructure/runtime/config/project-settings-store.js";
import { revokeAllProjectToolGrants } from "../../modules/agent-runtime/project-tool-grants.js";
import { agentRuntimeStore } from "../../modules/agent-runtime/session-store.js";
import { invalidateSessionEnvironment } from "../../modules/agent-runtime/session-environment.js";
import { refreshSessionWorkspaceRoots } from "../../modules/agent-runtime/tools/workspace.js";
import { gitEpicStore, indexBranchSessions } from "../../modules/git-epics.js";
import {
  createGitWorktree,
  GitWorkspaceError,
  listGitWorkspaces,
  gitHistoryPage,
  gitHistoryRefs,
  gitCommitDetail,
  gitHistoryAction,
  gitHistoryState,
  gitHistoryConflict,
  pruneGitWorktrees,
  removeGitWorktree,
  previewGitWorktreePath,
  previewGitWorktreeCleanup,
  cleanupGitWorktrees,
  previewGitWorktreePrune,
} from "../../modules/git-workspaces.js";
import { listGitSessions } from "../../modules/git-session-index.js";
import { resolveWorkspaceRootsFromSession } from "../../modules/agent-runtime/tools/workspace.js";
import { projectSessionState } from "../../modules/agent-runtime/session-projection.js";
import type { AgentSession } from "../../modules/agent-runtime/contracts.js";
import { MAX_WORKTREE_CLEANUP_PATHS, isTerminalWorktreeSession } from "../../modules/git-worktree-management-contracts.js";
import { resolveWorkspaceProjectLocation, type WorkspacePathResolution } from "../../modules/workspace-project-location.js";
import {
  workspaceIndexService,
} from "../../modules/workspace-index-service.js";

// ---------------------------------------------------------------------------
// Project store — in-memory Map 与磁盘 JSON 双写（原子写入）
// 落盘路径：<DATA_ROOT>/projects.json（默认 .data/projects.json）
// 策略：进程启动时从磁盘加载；无文件则初始化为空项目列表并落盘。
// 所有修改操作（POST / PATCH / DELETE）同步写回磁盘。
// ---------------------------------------------------------------------------

export interface ProjectRecord {
  primaryName?: string;
  references?: ProjectReference[];
  id: string;
  name: string;
  status: "healthy" | "at_risk" | "blocked";
  environment: "production" | "staging" | "development";
  healthScore: number;
  activeAgents: number;
  activeHumans: number;
  openRisks: number;
  updatedAt: string;
  source?: {
    kind: "scratch" | "git" | "localPath" | "wsl";
    repoUrl?: string;
    branch?: string;
    localPath?: string;
    distribution?: string;
    path?: string;
  };
  importState?: "idle" | "syncing" | "ready" | "failed";
  importError?: string;
  createdBy: string;
  createdAt: string;
}

const projects = new Map<string, ProjectRecord>();
const projectMutationQueues = new Map<string, Promise<void>>();

const PROJECTS_FILE = resolve(join(DATA_ROOT, "projects.json"));

const WORKSPACE_TREE_MAX_ENTRIES = 100;
// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function atomicWriteJson(filePath: string, data: unknown): void {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, filePath);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), file: filePath },
      "[store] atomicWrite failed",
    );
    throw err;
  }
}

function loadJsonFile<T>(filePath: string, key?: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed) return null;
    const data = key ? (parsed[key] as T) : (parsed as T);
    if (!Array.isArray(data)) return null;
    return data as T;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), file: filePath },
      "[store] loadJson failed",
    );
    return null;
  }
}

function saveProjectsToDisk(): void {
  const items = Array.from(projects.values());
  atomicWriteJson(PROJECTS_FILE, { items });
}

// ---------------------------------------------------------------------------
// Disk initialization and one-time cleanup of untouched legacy demo records
// ---------------------------------------------------------------------------

// Fingerprints are only for migration; these records must never be created again.
// Do not delete by name/ID alone: imported or customized projects are user data.
const legacyDemoFingerprints = [
  {
    id: "rumbling-core",
    name: "Rumbling Core",
    status: "at_risk",
    environment: "staging",
    healthScore: 72,
    activeAgents: 4,
    activeHumans: 2,
    openRisks: 2,
    updatedAt: "just now",
    createdBy: "alice",
  },
  {
    id: "growth-ops",
    name: "Growth Ops",
    status: "healthy",
    environment: "production",
    healthScore: 89,
    activeAgents: 3,
    activeHumans: 1,
    openRisks: 0,
    updatedAt: "12m ago",
    createdBy: "alice",
  },
  {
    id: "mobile-revamp",
    name: "Mobile Revamp",
    status: "blocked",
    environment: "development",
    healthScore: 54,
    activeAgents: 2,
    activeHumans: 2,
    openRisks: 3,
    updatedAt: "8m ago",
    createdBy: "alice",
  },
] as const;

function isUntouchedLegacyDemo(project: ProjectRecord): boolean {
  if (
    project.source ||
    project.references?.length ||
    project.primaryName ||
    project.importState ||
    project.importError
  )
    return false;
  return legacyDemoFingerprints.some((fingerprint) =>
    Object.entries(fingerprint).every(
      ([key, value]) => project[key as keyof ProjectRecord] === value,
    ),
  );
}

const diskProjects = loadJsonFile<ProjectRecord[]>(PROJECTS_FILE, "items");
if (diskProjects !== null) {
  const retained = diskProjects.filter(
    (project) => !isUntouchedLegacyDemo(project),
  );
  for (const project of retained) projects.set(project.id, project);
  if (retained.length !== diskProjects.length) saveProjectsToDisk();
  logger.info(
    {
      count: projects.size,
      removedLegacyDemos: diskProjects.length - retained.length,
      file: PROJECTS_FILE,
    },
    "[projects] loaded from disk",
  );
} else {
  saveProjectsToDisk();
  logger.info(
    { count: projects.size, file: PROJECTS_FILE },
    "[projects] initialized empty store",
  );
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  environment: z
    .enum(["production", "staging", "development"])
    .default("development"),
  source: z.object({
    kind: z.enum(["scratch", "git", "localPath", "wsl"]),
    repoUrl: z.string().optional(),
    branch: z.string().optional(),
    commitSha: z.string().optional(),
    localPath: z.string().optional(),
    distribution: z.string().optional(),
    path: z.string().optional(),
    provider: z.enum(["github", "gitlab"]).optional(),
  }),
  description: z.string().optional(),
  overwriteExisting: z.boolean().optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  environment: z.enum(["production", "staging", "development"]).optional(),
  status: z.enum(["healthy", "at_risk", "blocked"]).optional(),
  healthScore: z.number().int().min(0).max(100).optional(),
  importState: z.enum(["idle", "syncing", "ready", "failed"]).optional(),
  importError: z.string().optional(),
  activeAgents: z.number().int().min(0).optional(),
  activeHumans: z.number().int().min(0).optional(),
  openRisks: z.number().int().min(0).optional(),
});

const createWorktreeSchema = z.object({
  rootId: z.string().min(1).optional(),
  branch: z.string().min(1).max(1024),
  createBranch: z.boolean().optional().default(false),
  startPoint: z.string().min(1).max(1024).optional(),
});

const removeWorktreeSchema = z.object({
  rootId: z.string().min(1).optional(),
  path: z.string().min(1).max(4096),
  force: z.boolean().optional().default(false),
});

const cleanupWorktreeSchema = z.object({
  rootId: z.string().min(1).optional(),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(MAX_WORKTREE_CLEANUP_PATHS),
});

// ---------------------------------------------------------------------------
// Helper: check for duplicate projects
// ---------------------------------------------------------------------------

interface DuplicateCheck {
  exists: boolean;
  existingId?: string;
  existingName?: string;
  reason?: string;
}

function checkDuplicate(source: {
  kind: string;
  repoUrl?: string;
  localPath?: string;
  distribution?: string;
  path?: string;
}): DuplicateCheck {
  for (const p of projects.values()) {
    if (source.kind === "git" && source.repoUrl && p.source?.repoUrl) {
      const existing = p.source.repoUrl.toLowerCase().replace(/\.git$/, "");
      const incoming = source.repoUrl.toLowerCase().replace(/\.git$/, "");
      if (existing === incoming) {
        return {
          exists: true,
          existingId: p.id,
          existingName: p.name,
          reason: `已存在相同 Git 仓库的项目「${p.name}」`,
        };
      }
    }
    const incomingLocation: WorkspaceLocation | undefined =
      source.kind === "localPath" && source.localPath
        ? { kind: "host", path: source.localPath }
        : source.kind === "wsl" && source.distribution && source.path
          ? {
              kind: "wsl",
              distribution: source.distribution,
              path: source.path,
            }
          : undefined;
    const existingLocation = projectSourceLocation(p);
    if (
      incomingLocation &&
      existingLocation &&
      physicalLocationKey(existingLocation) ===
        physicalLocationKey(incomingLocation)
    ) {
      return {
        exists: true,
        existingId: p.id,
        existingName: p.name,
        reason: `已存在相同工作区路径的项目「${p.name}」`,
      };
    }
  }
  return { exists: false };
}

// ---------------------------------------------------------------------------
// Helper: cleanup git work directory
// ---------------------------------------------------------------------------

function cleanupGitWorkDir(projectId: string): {
  cleaned: boolean;
  error?: string;
} {
  try {
    const reposDir = resolve(join(DATA_ROOT, "repos", projectId));
    if (existsSync(reposDir)) {
      rmSync(reposDir, { recursive: true, force: true });
      logger.info(
        { projectId, path: reposDir },
        "[projects] cleaned git work dir",
      );
      return { cleaned: true };
    }
    return { cleaned: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { projectId, err: msg },
      "[projects] failed to clean git work dir",
    );
    return { cleaned: false, error: msg };
  }
}

function projectGitRoot(
  project: ProjectRecord,
  rootId?: string,
  requireSelection = false,
) {
  const roots = projectWorkspaceRoots(project);
  if (requireSelection && roots.length > 1 && !rootId)
    throw new GitWorkspaceError(
      "Select a workspace project before changing Git state.",
      400,
    );
  const root = roots.find((item) => item.id === (rootId ?? project.id));
  if (!root) throw new GitWorkspaceError("Workspace project not found.", 404);
  if (root.status !== "available")
    throw new GitWorkspaceError("Workspace directory is unavailable.", 409);
  const location = workspaceRootLocation(root);
  return {
    id: root.id,
    name: root.name,
    role: root.role,
    status: root.status,
    path: root.path,
    location,
    repository: location.kind === "host" ? location.path : location,
    hostPath: workspaceRootHostPath(root),
    scope: root.role === "primary" ? project.id : `${project.id}/${root.id}`,
  };
}

function readWorktreeSessionUsage() {
  const sessionCounts = new Map<string, number>();
  const activeSessionCounts = new Map<string, number>();
  const canonicalPaths = new Map<string, string>();
  for (const session of listGitSessions()) {
    const backend = session.backend;
    const active = !isTerminalWorktreeSession(session.status) || Boolean(session.pendingResumeToken) ||
      Boolean(session.activeRunId && !isTerminalWorktreeSession(session.runStatus));
    const paths = new Set([backend?.workDir, ...(backend?.workspaceRoots ?? []).map(root => root.path)]
      .filter((value): value is string => typeof value === "string" && Boolean(value))
      .map(value => {
        const cached = canonicalPaths.get(value);
        if (cached) return cached;
        let canonical: string;
        try { canonical = canonicalWorkspaceDirectory(value); } catch { canonical = normalize(value); }
        canonicalPaths.set(value, canonical);
        return canonical;
      }));
    for (const key of paths) {
      sessionCounts.set(key, (sessionCounts.get(key) ?? 0) + 1);
      if (active) activeSessionCounts.set(key, (activeSessionCounts.get(key) ?? 0) + 1);
    }
  }
  return { sessionCounts, activeSessionCounts };
}

function gitWorkspaceRouteError(c: Context, error: unknown) {
  if (error instanceof GitWorkspaceError) {
    return c.json(
      { error: error.message, code: "GIT_WORKSPACE_ERROR" },
      error.status as 400 | 404 | 409 | 500 | 503,
    );
  }
  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    "[projects] git workspace operation failed",
  );
  return c.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Git workspace operation failed.",
    },
    500,
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const projectRoutes = new Hono();

function invalidateWorkspaceSessionEnvironments(projectId: string): void {
  for (const session of agentRuntimeStore.listSessions({
    projectId,
    limit: Number.MAX_SAFE_INTEGER,
  })) {
    // Drop the membership frozen at bind time so idle sessions pick up the
    // linked/unlinked root; in-flight runs keep theirs until they finish.
    refreshSessionWorkspaceRoots(session.id);
    invalidateSessionEnvironment(session.id);
  }
}
projectRoutes.route('/:projectId/git/mr', createGitMrRoutes((projectId, rootId) => {
  const project = projects.get(projectId);
  if (!project) throw new GitWorkspaceError('Project not found.', 404);
  return projectGitRoot(project, rootId).location;
}));

const workspaceLocationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("host"),
      path: z.string().trim().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wsl"),
      distribution: z.string().trim().min(1).max(256),
      path: z.string().trim().min(1).max(4096),
    })
    .strict(),
]);

const workspaceRootInputSchema = z.union([
  z
    .object({
      location: workspaceLocationSchema,
      name: z.string().trim().min(1).max(120).optional(),
    })
    .strict(),
  z
    .object({
      localPath: z.string().trim().min(1).max(4096),
      name: z.string().trim().min(1).max(120).optional(),
    })
    .strict(),
  z.object({ projectId: z.string().min(1) }).strict(),
]);

const createWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    roots: z.array(workspaceRootInputSchema).min(1).max(50),
  })
  .strict();

async function withProjectMutation<T>(
  projectId: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = projectMutationQueues.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  projectMutationQueues.set(projectId, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (projectMutationQueues.get(projectId) === queued)
      projectMutationQueues.delete(projectId);
  }
}

function locationName(location: WorkspaceLocation): string {
  return location.kind === "wsl"
    ? path.posix.basename(location.path) || location.path
    : basename(location.path);
}

function sourceFromLocation(
  location: WorkspaceLocation,
): ProjectRecord["source"] {
  return location.kind === "wsl"
    ? { kind: "wsl", distribution: location.distribution, path: location.path }
    : { kind: "localPath", localPath: location.path };
}

function referenceFromLocation(
  id: string,
  name: string,
  location: WorkspaceLocation,
): ProjectReference {
  return location.kind === "wsl"
    ? { id, name, location }
    : { id, name, localPath: location.path };
}

async function resolveRootInput(
  input: z.infer<typeof workspaceRootInputSchema>,
): Promise<WorkspacePathResolution & { existing?: ProjectRecord }> {
  if ("projectId" in input) {
    const existing = projects.get(input.projectId);
    if (!existing)
      throw Object.assign(new Error("Selected project not found"), {
        status: 404,
      });
    const location = projectSourceLocation(existing);
    if (!location) throw new Error("Selected project has no local workspace");
    const resolved = await resolveWorkspaceProjectLocation(location);
    return { ...resolved, name: resolved.redirected ? resolved.name : existing.primaryName ?? existing.name, existing };
  }
  const location =
    "location" in input
      ? input.location
      : { kind: "host" as const, path: input.localPath };
  const resolved = await resolveWorkspaceProjectLocation(location);
  return { ...resolved, name: resolved.redirected ? resolved.name : input.name ?? resolved.name };
}

projectRoutes.post("/workspace-path", async (c) => {
  const parsed = workspaceRootInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid workspace directory." }, 400);
  try {
    const { existing: _existing, ...resolved } = await resolveRootInput(parsed.data);
    return c.json(resolved);
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

// Validate every membership before publishing the workspace in memory or on disk.
projectRoutes.post("/workspaces", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createWorkspaceSchema.safeParse(body);
  if (!parsed.success)
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400,
    );
  const now = new Date().toISOString();
  const project: ProjectRecord = {
    id: `ws_${randomUUID()}`,
    name: parsed.data.name,
    references: [],
    status: "healthy",
    environment: "development",
    healthScore: 0,
    activeAgents: 0,
    activeHumans: 1,
    openRisks: 0,
    updatedAt: now,
    createdAt: now,
    createdBy: "current-user",
    importState: "ready",
  };
  const normalizations: WorkspacePathResolution[] = [];
  try {
    for (const input of parsed.data.roots) {
      const resolved = await resolveRootInput(input);
      const key = physicalLocationKey(resolved.location);
      const duplicate = projectWorkspaceRoots(project).some(root => physicalLocationKey(workspaceRootLocation(root)) === key);
      if (duplicate && (resolved.redirected || normalizations.some(item => item.redirected && physicalLocationKey(item.location) === key))) {
        normalizations.push({ ...resolved, duplicate: true });
        continue;
      }
      if (resolved.redirected) normalizations.push(resolved);
      const location = project.source
        ? await validateProjectReferenceLocation(project, resolved.location)
        : await canonicalizeWorkspaceLocation(resolved.location);
      const name = resolved.name ?? locationName(location);
      if (!project.source) {
        project.source = sourceFromLocation(location);
        project.primaryName = name;
      } else {
        project.references!.push(
          referenceFromLocation(`ref_${randomUUID()}`, name, location),
        );
      }
    }
  } catch (error) {
    const status = (error as { status?: number }).status === 404 ? 404 : 400;
    return c.json({ error: (error as Error).message }, status);
  }
  projects.set(project.id, project);
  try {
    initializeProjectSettings(project.id);
    saveProjectsToDisk();
  } catch (error) {
    projects.delete(project.id);
    throw error;
  }
  workspaceIndexService.indexProject(project.id, projectWorkspaceRoots(project));
  return c.json({ project, roots: projectWorkspaceRoots(project), normalizations }, 201);
});

/** The explorer and file viewer must resolve the same session worktree. */
async function treeRoots(project: ProjectRecord, sessionId?: string) {
  if (!sessionId) return projectWorkspaceRoots(project);
  const snapshot = await runtimeFacade.uiSnapshotAuthoritative(sessionId);
  const session = projectSessionState(snapshot.session as never) as AgentSession;
  if (session.projectId !== project.id) throw new GitWorkspaceError("Session is outside this workspace.", 404);
  return resolveWorkspaceRootsFromSession(session);
}
async function treeRoot(project: ProjectRecord, rootId?: string, sessionId?: string) {
  const roots = await treeRoots(project, sessionId);
  const root = rootId ? roots.find(item => item.id === rootId) : roots.find(item => item.role === "primary");
  if (!root) throw new GitWorkspaceError("Workspace project not found.", 404);
  if (root.status !== "available") throw new GitWorkspaceError("Workspace directory is unavailable.", 409);
  return root;
}
projectRoutes.get("/:id/workspace", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  try { return c.json({ roots: await treeRoots(project, c.req.query("sessionId")) }); }
  catch (error) { return gitWorkspaceRouteError(c, error); }
});

projectRoutes.get("/:id/tree/status", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  try {
    const root = await treeRoot(project, c.req.query("rootId"), c.req.query("sessionId"));
    return c.json(await workspaceIndexService.status(root));
  } catch (error) {
    if (error instanceof GitWorkspaceError) return gitWorkspaceRouteError(c, error);
    return c.json({ error: "Rust workspace indexer is unavailable.", code: "INDEX_UNAVAILABLE" }, 503);
  }
});

const addReferenceSchema = workspaceRootInputSchema;

projectRoutes.post("/:id/references", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = addReferenceSchema.safeParse(body);
  if (!parsed.success)
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400,
    );
  const projectId = c.req.param("id");
  try {
    const result = await withProjectMutation(projectId, async () => {
      const project = projects.get(projectId);
      if (!project)
        throw Object.assign(new Error("Project not found"), { status: 404 });
      const resolved = await resolveRootInput(parsed.data);
      // Validation occurs inside the project queue so concurrent writes see every prior membership.
      const latest = projects.get(projectId)!;
      const currentRoots = projectWorkspaceRoots(latest);
      if (resolved.redirected && currentRoots.some(root => physicalLocationKey(workspaceRootLocation(root)) === physicalLocationKey(resolved.location)))
        return { roots: currentRoots, normalization: { ...resolved, duplicate: true } };
      if (projectWorkspaceRoots(latest).length >= 50)
        throw new Error("A workspace supports up to 50 projects.");
      const location = await validateProjectReferenceLocation(
        latest,
        resolved.location,
      );
      const name = resolved.name ?? locationName(location);
      const updated = {
        ...latest,
        references: [
          ...(latest.references ?? []),
          referenceFromLocation(`ref_${randomUUID()}`, name, location),
        ],
        updatedAt: new Date().toISOString(),
      };
      atomicWriteJson(PROJECTS_FILE, {
        items: [...projects.values()].map((item) =>
          item.id === latest.id ? updated : item,
        ),
      });
      projects.set(latest.id, updated);
      return { roots: projectWorkspaceRoots(updated), normalization: resolved.redirected ? resolved : undefined };
    });
    workspaceIndexService.indexProject(projectId, result.roots);
    invalidateWorkspaceSessionEnvironments(projectId);
    return c.json(result, 201);
  } catch (error) {
    const status = (error as { status?: number }).status === 404 ? 404 : 400;
    return c.json({ error: (error as Error).message }, status);
  }
});

projectRoutes.delete("/:id/references/:referenceId", async (c) => {
  const projectId = c.req.param("id");
  const referenceId = c.req.param("referenceId");
  try {
    const roots = await withProjectMutation(projectId, async () => {
      const project = projects.get(projectId);
      if (!project) throw Object.assign(new Error("Project not found"), { status: 404 });
      if (!project.references?.some(reference => reference.id === referenceId))
        throw Object.assign(new Error("Reference not found"), { status: 404 });
      const updated = {
        ...project,
        references: project.references.filter(reference => reference.id !== referenceId),
        updatedAt: new Date().toISOString(),
      };
      atomicWriteJson(PROJECTS_FILE, {
        items: [...projects.values()].map(item => item.id === projectId ? updated : item),
      });
      projects.set(projectId, updated);
      return projectWorkspaceRoots(updated);
    });
    invalidateWorkspaceSessionEnvironments(projectId);
    return c.json({ roots });
  } catch (error) {
    if ((error as { status?: number }).status === 404)
      return c.json({ error: (error as Error).message }, 404);
    throw error;
  }
});

// ─── Project Routes ────────────────────────────────────────────────────────

/** GET / — list all projects with optional search, filter, sort */
projectRoutes.get("/", (c) => {
  let items = Array.from(projects.values());

  // Search
  const search = c.req.query("search")?.toLowerCase();
  if (search) {
    items = items.filter(
      (p) =>
        p.name.toLowerCase().includes(search) ||
        p.id.toLowerCase().includes(search) ||
        (p.source?.repoUrl &&
          p.source.repoUrl.toLowerCase().includes(search)) ||
        (p.source?.localPath &&
          p.source.localPath.toLowerCase().includes(search)) ||
        (p.source?.kind === "wsl" &&
          `${p.source.distribution ?? ""} ${p.source.path ?? ""}`
            .toLowerCase()
            .includes(search)),
    );
  }

  // Filter by status
  const statusFilter = c.req.query("status");
  if (statusFilter) {
    const statuses = statusFilter.split(",");
    items = items.filter((p) => statuses.includes(p.status));
  }

  // Filter by environment
  const envFilter = c.req.query("environment");
  if (envFilter) {
    const envs = envFilter.split(",");
    items = items.filter((p) => envs.includes(p.environment));
  }

  // Filter by import state
  const importFilter = c.req.query("importState");
  if (importFilter) {
    const states = importFilter.split(",");
    items = items.filter(
      (p) => p.importState && states.includes(p.importState),
    );
  }

  // Sort
  const sortBy = c.req.query("sort") || "createdAt";
  const sortDir = c.req.query("order") || "desc";

  items.sort((a, b) => {
    let aVal: number | string, bVal: number | string;
    switch (sortBy) {
      case "name":
        aVal = a.name.toLowerCase();
        bVal = b.name.toLowerCase();
        break;
      case "healthScore":
        aVal = a.healthScore;
        bVal = b.healthScore;
        break;
      case "updatedAt":
        aVal = new Date(
          a.updatedAt === "just now" ? Date.now() : a.updatedAt,
        ).getTime();
        bVal = new Date(
          b.updatedAt === "just now" ? Date.now() : b.updatedAt,
        ).getTime();
        break;
      case "status":
        aVal = a.status;
        bVal = b.status;
        break;
      case "environment":
        aVal = a.environment;
        bVal = b.environment;
        break;
      case "createdAt":
      default:
        aVal = new Date(a.createdAt).getTime();
        bVal = new Date(b.createdAt).getTime();
        break;
    }
    const cmp =
      typeof aVal === "string"
        ? aVal.localeCompare(bVal as string)
        : aVal - (bVal as number);
    return sortDir === "asc" ? cmp : -cmp;
  });

  return c.json({ items, total: items.length });
});

// ── Remaining Project Routes ──

/**
 * List one directory level from a workspace root.
 *
 * Rust owns the index and watcher. This route only validates the workspace
 * member and adapts the sidecar's revisioned page contract to HTTP.
 */
projectRoutes.get("/:id/tree", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);

  const query = z
    .object({
      rootId: z.string().min(1).optional(),
      sessionId: z.string().min(1).max(256).optional(),
      path: z.string().max(4096).optional(),
      showHidden: z.enum(["1", "true"]).optional(),
      showIgnored: z.enum(["1", "true"]).optional(),
      limit: z.coerce.number().int().min(1).max(WORKSPACE_TREE_MAX_ENTRIES).optional(),
      cursor: z.string().max(16384).optional(),
    })
    .safeParse(c.req.query());
  if (!query.success)
    return c.json({ error: "Invalid workspace tree query" }, 400);

  try {
    const root = await treeRoot(project, query.data.rootId, query.data.sessionId);
    const relativePath = query.data.path === "." ? "" : (query.data.path ?? "");
    const showHidden = query.data.showHidden === "1" || query.data.showHidden === "true";
    const showIgnored = query.data.showIgnored === "1" || query.data.showIgnored === "true";
    const limit = query.data.limit ?? WORKSPACE_TREE_MAX_ENTRIES;
    const listing = await workspaceIndexService.listChildren({
      projectId: project.id,
      root,
      relativePath,
      showHidden,
      showIgnored,
      cursor: query.data.cursor,
      limit,
    });
    return c.json(listing);
  } catch (error) {
    const indexCode = (error as { code?: string }).code;
    if (indexCode === "INVALID_PATH") return c.json({ error: String(error), code: indexCode }, 400);
    if (indexCode === "INDEX_NOT_FOUND") return c.json({ error: String(error), code: indexCode }, 404);
    if (indexCode === "INDEX_FORBIDDEN") return c.json({ error: String(error), code: indexCode }, 403);
    if (indexCode === "INDEX_CURSOR_STALE") return c.json({ error: String(error), code: indexCode }, 409);
    if (error instanceof GitWorkspaceError)
      return c.json({ error: error.message }, error.status as 400 | 404 | 409 | 500);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return c.json({ error: "Workspace directory not found." }, 404);
    if (code === "EACCES" || code === "EPERM")
      return c.json({ error: "Workspace directory is not readable." }, 403);
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "[projects] workspace tree listing failed",
    );
    return c.json({ error: "Rust workspace indexer is unavailable.", code: "INDEX_UNAVAILABLE" }, 503);
  }
});

/** GET /:id/git/workspaces — list local branches and linked worktrees. */
projectRoutes.get("/:id/git/workspaces", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  try {
    const root = projectGitRoot(project, c.req.query("rootId"));
    const inventoryOnly = c.req.query("mode") === "inventory";
    const usage = inventoryOnly ? undefined : readWorktreeSessionUsage();
    return c.json(
      await listGitWorkspaces(
        root.repository,
        root.scope,
        usage?.sessionCounts,
        usage?.activeSessionCounts,
        { includeHistory: false, inspectStatus: !inventoryOnly },
      ),
    );
  } catch (error) {
    return gitWorkspaceRouteError(c, error);
  }
});

/** POST /:id/git/worktrees — create a linked worktree, optionally with a new branch. */
projectRoutes.get("/:id/git/history", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  try {
    const root = projectGitRoot(project, c.req.query("rootId"));
    return c.json(await gitHistoryPage(root.repository, {
      offset: Number(c.req.query("offset") ?? 0),
      limit: Number(c.req.query("limit") ?? 100),
      snapshot: c.req.query("snapshot"),
    }));
  } catch (error) { return gitWorkspaceRouteError(c, error); }
});

projectRoutes.get("/:id/git/associations", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  try {
    const root = projectGitRoot(project, c.req.query("rootId"));
    const [workspace, refs, epics] = await Promise.all([
      listGitWorkspaces(root.repository, root.scope, undefined, undefined, { includeHistory: false, inspectStatus: false }), gitHistoryRefs(root.repository), gitEpicStore.list(project.id, root.scope),
    ]);
    const sessions = listGitSessions(project.id).map(session => {
      const backend = session.backend;
      const workPaths = [backend?.workDir, ...(backend?.workspaceRoots ?? []).map(item => item.path)].filter((value): value is string => Boolean(value)).map(value => {
        try { return canonicalWorkspaceDirectory(value); } catch { return normalize(value); }
      });
      return { id: session.id, title: session.title, status: session.status, workPaths };
    });
    return c.json({ epics, refs, sessions: sessions.map(({ id, title, status }) => ({ id, title, status })), branches: indexBranchSessions(refs.map(ref => ref.fullName), workspace.worktrees, sessions, epics) });
  } catch (error) { return gitWorkspaceRouteError(c, error); }
});

projectRoutes.get("/:id/git/state", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  try { return c.json(await gitHistoryState(projectGitRoot(project, c.req.query("rootId")).repository)); }
  catch (error) { return gitWorkspaceRouteError(c, error); }
});
projectRoutes.get("/:id/git/conflict", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  try { return c.json(await gitHistoryConflict(projectGitRoot(project, c.req.query("rootId")).repository, c.req.query("path") ?? "", undefined, undefined, c.req.raw.signal)); }
  catch (error) { return gitWorkspaceRouteError(c, error); }
});
projectRoutes.get('/:id/git/conflict/content', async c => {
  const project = projects.get(c.req.param('id'));
  if (!project) return c.json({ error: 'Project not found' }, 404);
  try {
    const { path: filePath, rootId, ...query } = c.req.query();
    if (!filePath) return c.json({ error: 'Conflict path is required.' }, 400);
    const parsed = conversationGitSliceSchema.safeParse(query);
    if (!parsed.success) return c.json({ error: 'Invalid conflict content range.' }, 400);
    return c.json(await gitHistoryConflict(projectGitRoot(project, rootId).repository, filePath, undefined, parsed.data, c.req.raw.signal));
  } catch (error) { return gitWorkspaceRouteError(c, error); }
});
projectRoutes.put("/:id/git/conflict", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  const schema = z.object({ rootId: z.string().optional(), path: z.string().min(1).max(4096), expectedRevision: z.string().min(1), content: z.string().max(2 * 1024 * 1024).optional(), choice: z.enum(["target", "source", "delete"]).optional(), resolve: z.boolean(), resolutionState: z.unknown().optional() });
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = schema.safeParse(body);
  if (!parsed.success || JSON.stringify(parsed.data.resolutionState ?? null).length > 100 * 1024) return c.json({ error: "Invalid conflict save" }, 400);
  try { return c.json(await gitHistoryConflict(projectGitRoot(project, parsed.data.rootId, true).repository, parsed.data.path, parsed.data)); }
  catch (error) { return gitWorkspaceRouteError(c, error); }
});

projectRoutes.post("/:id/git/epics", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  const schema = z.object({ rootId: z.string().optional(), id: z.string().uuid().optional(), expectedVersion: z.number().int().positive().optional(), name: z.string().trim().min(1).max(160), description: z.string().max(10000), refs: z.array(z.string().regex(/^refs\/(heads|remotes|tags)\/.+/)).max(100), sessionIds: z.array(z.string().max(160)).max(500), archived: z.boolean() });
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid Epic", details: parsed.error.flatten() }, 400);
  try {
    const root = projectGitRoot(project, parsed.data.rootId, true);
    await agentRuntimeStore.hydrateSessions();
    const sessions = new Set(agentRuntimeStore.listSessions({ projectId: project.id, limit: Number.MAX_SAFE_INTEGER }).map(session => session.id));
    if (parsed.data.sessionIds.some(id => !sessions.has(id))) throw new GitWorkspaceError("Select unarchived sessions in this project.");
    return c.json(await gitEpicStore.save(project.id, root.scope, parsed.data));
  } catch (error) { return gitWorkspaceRouteError(c, error); }
});

projectRoutes.get("/:id/git/commits/:sha", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  try {
    const root = projectGitRoot(project, c.req.query("rootId"));
    return c.json(await gitCommitDetail(root.repository, c.req.param("sha")));
  } catch (error) { return gitWorkspaceRouteError(c, error); }
});

projectRoutes.post("/:id/git/actions", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  const schema = z.object({
    rootId: z.string().optional(),
    action: z.enum(["merge", "rebase", "cherry-pick", "reset", "fetch", "track", "continue", "abort"]),
    expectedHead: z.string().regex(/^[a-f0-9]{40,64}$/i),
    target: z.string().max(1024).optional(),
    branch: z.string().max(255).optional(),
    resetMode: z.enum(["soft", "mixed", "hard"]).optional(),
    confirmed: z.boolean().optional(),
  });
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid Git action", details: parsed.error.flatten() }, 400);
  try {
    const root = projectGitRoot(project, parsed.data.rootId, true);
    return c.json(await gitHistoryAction(root.repository, parsed.data));
  } catch (error) { return gitWorkspaceRouteError(c, error); }
});

projectRoutes.get("/:id/git/worktrees/preview", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  const branch = z.string().min(1).max(1024).safeParse(c.req.query("branch"));
  if (!branch.success) return c.json({ error: "Invalid branch" }, 400);
  try {
    const root = projectGitRoot(project, c.req.query("rootId"), true);
    return c.json(await previewGitWorktreePath(root.repository, root.scope, branch.data));
  } catch (error) { return gitWorkspaceRouteError(c, error); }
});

projectRoutes.get("/:id/git/worktrees/cleanup", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  try {
    const root = projectGitRoot(project, c.req.query("rootId"), true);
    return c.json(await previewGitWorktreeCleanup(root.repository, root.scope, readWorktreeSessionUsage));
  } catch (error) { return gitWorkspaceRouteError(c, error); }
});

projectRoutes.post("/:id/git/worktrees/cleanup", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const parsed = cleanupWorktreeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
  try {
    const root = projectGitRoot(project, parsed.data.rootId, true);
    return c.json(await cleanupGitWorktrees(root.repository, root.scope, [...new Set(parsed.data.paths)], readWorktreeSessionUsage));
  } catch (error) { return gitWorkspaceRouteError(c, error); }
});

projectRoutes.post("/:id/git/worktrees", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = createWorktreeSchema.safeParse(body);
  if (!parsed.success)
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400,
    );
  try {
    const root = projectGitRoot(project, parsed.data.rootId, true);
    const worktree = await createGitWorktree(
      root.repository,
      root.scope,
      parsed.data,
    );
    return c.json({ worktree }, 201);
  } catch (error) {
    return gitWorkspaceRouteError(c, error);
  }
});

/** DELETE /:id/git/worktrees — remove a linked worktree after safety checks. */
projectRoutes.delete("/:id/git/worktrees", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = removeWorktreeSchema.safeParse(body);
  if (!parsed.success)
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400,
    );
  try {
    const root = projectGitRoot(project, parsed.data.rootId, true);
    await removeGitWorktree(root.repository, root.scope, parsed.data.path, {
      force: parsed.data.force,
      readUsage: readWorktreeSessionUsage,
    });
    return c.json({ removed: true });
  } catch (error) {
    return gitWorkspaceRouteError(c, error);
  }
});

/** POST /:id/git/worktrees/prune — remove stale Git worktree registrations. */
projectRoutes.get("/:id/git/worktrees/prune", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  try {
    const root = projectGitRoot(project, c.req.query("rootId"), true);
    return c.json(await previewGitWorktreePrune(root.repository));
  } catch (error) { return gitWorkspaceRouteError(c, error); }
});

projectRoutes.post("/:id/git/worktrees/prune", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) return c.json({ error: "Project not found" }, 404);
  try {
    const body = await c.req.json().catch(() => null);
    const parsed = cleanupWorktreeSchema.extend({ paths: z.array(z.string().min(1).max(4096)).max(MAX_WORKTREE_CLEANUP_PATHS) }).safeParse(body);
    if (!parsed.success) return c.json({ error: "Preview and confirm the complete prune path list first." }, 400);
    const queryRoot = c.req.query("rootId");
    if (queryRoot && parsed.data.rootId && queryRoot !== parsed.data.rootId) return c.json({ error: "Conflicting rootId" }, 400);
    const root = projectGitRoot(project, parsed.data.rootId ?? queryRoot, true);
    await pruneGitWorktrees(root.repository, [...new Set(parsed.data.paths)], readWorktreeSessionUsage);
    const usage = readWorktreeSessionUsage();
    return c.json(
      await listGitWorkspaces(
        root.repository,
        root.scope,
        usage.sessionCounts,
        usage.activeSessionCounts,
        { includeHistory: false },
      ),
    );
  } catch (error) {
    return gitWorkspaceRouteError(c, error);
  }
});

/** Project activity comes from the authoritative Agent sessions. */
projectRoutes.get('/:id/stats',async c=>{
  const id=c.req.param('id');if(!projects.has(id)) return c.json({error:'Not found'},404);
  const sessions=(await runtimeFacade.listSessionProjection()) as import('../../modules/agent-runtime/contracts.js').AgentSession[];
  const visible=sessions.filter(s=>s.projectId===id && !s.sessionMetadata?.deletedAt && !s.sessionMetadata?.archivedAt);
  const recent=new Date(Date.now()-7*86400000).toISOString();
  const runs=await Promise.all(visible.map(s=>runtimeFacade.listRunHistory(s.id)));
  return c.json({sessionCount:visible.length,nodeCount:0,recentRunCount:runs.flat().filter(r=>(r as {startedAt:string}).startedAt>recent).length,lastActivity:visible.map(s=>s.updatedAt).sort().at(-1) ?? null});
});

/** GET /:id — get single project */
projectRoutes.get("/:id", (c) => {
  const id = c.req.param("id");
  const project = projects.get(id);
  if (!project) return c.json({ error: "Project not found" }, 404);
  return c.json(project);
});

/** POST /check-duplicate — check if a project with same source already exists */
projectRoutes.post("/check-duplicate", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const {
    kind,
    repoUrl,
    localPath,
    distribution,
    path: wslPath,
  } = body as Record<string, unknown>;
  const result = checkDuplicate({
    kind: (kind as string) ?? "",
    repoUrl: repoUrl as string | undefined,
    localPath: localPath as string | undefined,
    distribution: distribution as string | undefined,
    path: wslPath as string | undefined,
  });
  return c.json(result);
});

/** POST / — create project (with duplicate detection) */
projectRoutes.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400,
    );
  }

  const { name, environment, source, description: description, overwriteExisting } =
    parsed.data;
  if (source.kind === "wsl") {
    if (!source.distribution || !source.path)
      return c.json(
        { error: "WSL source requires distribution and path" },
        400,
      );
    try {
      const canonical = await canonicalizeWorkspaceLocation({
        kind: "wsl",
        distribution: source.distribution,
        path: source.path,
      });
      if (canonical.kind !== "wsl")
        throw new Error(
          "WSL workspace normalization returned the wrong runtime.",
        );
      source.distribution = canonical.distribution;
      source.path = canonical.path;
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "WSL workspace is unavailable",
        },
        400,
      );
    }
  }

  // Legacy project imports use the same worktree interception as workspaces.
  let normalization: WorkspacePathResolution | undefined;
  if ((source.kind === "localPath" && source.localPath) || (source.kind === "wsl" && source.distribution && source.path)) {
    try {
      normalization = await resolveWorkspaceProjectLocation(source.kind === "wsl"
        ? { kind: "wsl", distribution: source.distribution!, path: source.path! }
        : { kind: "host", path: source.localPath! });
      if (normalization.location.kind === "host") source.localPath = normalization.location.path;
      else { source.path = normalization.location.path; source.distribution = normalization.location.distribution; }
    } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  }
  // Check duplicates for git and localPath sources
  if (source.kind !== "scratch" && !overwriteExisting) {
    const dup = checkDuplicate({
      kind: source.kind,
      repoUrl: source.repoUrl,
      localPath: source.localPath,
      distribution: source.distribution,
      path: source.path,
    });
    if (dup.exists) {
      return c.json(
        {
          error: "Duplicate project source detected",
          duplicate: {
            existingId: dup.existingId,
            existingName: dup.existingName,
            reason: dup.reason,
          },
          code: "DUPLICATE_SOURCE",
        },
        409,
      );
    }
  }

  // If overwriting, delete the existing project first
  if (overwriteExisting && source.kind !== "scratch") {
    const dup = checkDuplicate({
      kind: source.kind,
      repoUrl: source.repoUrl,
      localPath: source.localPath,
      distribution: source.distribution,
      path: source.path,
    });
    if (dup.exists && dup.existingId) {
      cleanupGitWorkDir(dup.existingId);
      projects.delete(dup.existingId);
    }
  }

  const id = `proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const project: ProjectRecord = {
    id,
    name,
    status: "healthy",
    environment,
    healthScore: source.kind === "scratch" ? 80 : 0,
    activeAgents: 0,
    activeHumans: 1,
    openRisks: 0,
    updatedAt: "just now",
    source: {
      kind: source.kind,
      repoUrl: source.repoUrl,
      branch: source.branch || (source.kind === "git" ? "main" : undefined),
      localPath: source.localPath,
      distribution: source.distribution,
      path: source.path,
    },
    importState: source.kind === "scratch" ? "ready" : "syncing",
    createdBy: "current-user",
    createdAt: new Date().toISOString(),
  };

  projects.set(id, project);
  initializeProjectSettings(id);
  saveProjectsToDisk();
  workspaceIndexService.indexProject(id, projectWorkspaceRoots(project));
  logger.info({ projectId: id, name, kind: source.kind }, "[projects] created");

  return c.json({ project, normalization: normalization?.redirected ? normalization : undefined }, 201);
});

/** PATCH /:id — update project fields */
projectRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const project = projects.get(id);
  if (!project) return c.json({ error: "Project not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400,
    );
  }

  const oldStatus = project.status;
  const data = parsed.data;

  if (data.name !== undefined) project.name = data.name;
  if (data.environment !== undefined) project.environment = data.environment;
  if (data.status !== undefined) project.status = data.status;
  if (data.healthScore !== undefined) project.healthScore = data.healthScore;
  if (data.importState !== undefined) project.importState = data.importState;
  if (data.importError !== undefined) project.importError = data.importError;
  if (data.activeAgents !== undefined) project.activeAgents = data.activeAgents;
  if (data.activeHumans !== undefined) project.activeHumans = data.activeHumans;
  if (data.openRisks !== undefined) project.openRisks = data.openRisks;

  project.updatedAt = "just now";
  projects.set(id, project);
  saveProjectsToDisk();

  // Log status changes
  if (data.status && data.status !== oldStatus) {
    logger.info(
      { projectId: id, from: oldStatus, to: data.status },
      "[projects] status changed",
    );
  }

  return c.json(project);
});

/** DELETE /:id — remove project with git work dir cleanup and backup */
projectRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const project = projects.get(id);
  if (!project) return c.json({ error: "Project not found" }, 404);

  // Create backup before deletion
  const backupFile = resolve(join(DATA_ROOT, `projects_backup_${id}.json`));
  try {
    atomicWriteJson(backupFile, {
      project,
      backedUpAt: new Date().toISOString(),
    });
    logger.info(
      { projectId: id, backup: backupFile },
      "[projects] backup created before delete",
    );
  } catch {
    // Non-critical: continue with deletion even if backup fails
    logger.warn(
      { projectId: id },
      "[projects] backup failed, proceeding with delete",
    );
  }

  // Cleanup git work directory
  const cleanupResult = cleanupGitWorkDir(id);

  // Remove from memory and disk
  projects.delete(id);
  saveProjectsToDisk();
  revokeAllProjectToolGrants(id);
  logger.info(
    { projectId: id, gitCleaned: cleanupResult.cleaned },
    "[projects] deleted",
  );

  return c.json({
    ok: true,
    gitCleaned: cleanupResult.cleaned,
    gitCleanError: cleanupResult.error,
    backupFile: existsSync(backupFile) ? backupFile : undefined,
  });
});

// ---------------------------------------------------------------------------
// Exported helper: sync basics from project-settings into ProjectRecord
// ---------------------------------------------------------------------------

export function syncProjectBasics(
  projectId: string,
  basics: {
    name?: string;
    environment?: "production" | "staging" | "development";
  },
): boolean {
  const project = projects.get(projectId);
  if (!project) return false;
  let changed = false;
  if (basics.name !== undefined && basics.name !== project.name) {
    project.name = basics.name;
    changed = true;
  }
  if (
    basics.environment !== undefined &&
    basics.environment !== project.environment
  ) {
    project.environment = basics.environment;
    changed = true;
  }
  if (changed) {
    project.updatedAt = new Date().toISOString();
    projects.set(projectId, project);
    saveProjectsToDisk();
  }
  return changed;
}
