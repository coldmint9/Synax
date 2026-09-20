import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "../../../lib/env.js";
import { agentRuntimeStore } from "../session-store.js";
import { sandboxConfigForSession, sandboxPolicy } from "../sandbox/index.js";
import {
  projectSourceLocation,
  projectWorkspaceRoots,
  readWorkspaceProject,
  workspaceRootHostPath,
  type ProjectWorkspaceRoot,
} from "../../project-workspace.js";
import {
  canonicalizeWorkspaceLocationSync,
  parseWslUncPath,
  workspaceLocationHostPath,
  type WorkspaceLocation,
} from "../../workspace-location.js";

const sessionWorkspaceRoots = new Map<string, string>();

export function workspaceRoot(sessionId?: string): string {
  return sessionId
    ? (sessionWorkspaceRoots.get(sessionId) ?? path.resolve(process.cwd()))
    : path.resolve(process.cwd());
}

export function resolveWorkspaceRoot(inputPath = "."): string {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory())
    throw new Error("Workspace root must point to a directory.");
  return resolved;
}

export function setSessionWorkspaceRoot(
  sessionId: string,
  inputPath: string,
): string {
  const root = resolveWorkspaceRoot(inputPath);
  sessionWorkspaceRoots.set(sessionId, root);
  return root;
}

export function tryGetSessionWorkspaceRoot(
  sessionId: string,
): string | undefined {
  return sessionWorkspaceRoots.get(sessionId);
}

interface ProjectWorkDirEntry {
  id: string;
  name?: string;
  primaryName?: string;
  source?: {
    kind?: string;
    localPath?: string;
    distribution?: string;
    path?: string;
  };
}

function readProjectWorkDirEntries(): ProjectWorkDirEntry[] {
  const projectsFile = path.join(DATA_ROOT, "projects.json");
  const raw = JSON.parse(fs.readFileSync(projectsFile, "utf8")) as unknown;
  if (Array.isArray(raw)) return raw as ProjectWorkDirEntry[];
  if (
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { items?: unknown }).items)
  ) {
    return (raw as { items: ProjectWorkDirEntry[] }).items;
  }
  return [];
}

function entryLocation(
  entry: ProjectWorkDirEntry | undefined,
): WorkspaceLocation | undefined {
  return entry ? projectSourceLocation(entry) : undefined;
}

/** Resolve a project's host-accessible workspace root from the on-disk registry. */
export function resolveProjectWorkDir(projectId: string): string {
  try {
    const location = entryLocation(
      readProjectWorkDirEntries().find((entry) => entry.id === projectId),
    );
    if (location) return workspaceLocationHostPath(location);
  } catch {
    /* fall through */
  }
  return path.resolve(process.cwd());
}

export function resolveProjectWorkspaceLocation(
  projectId: string,
): WorkspaceLocation | undefined {
  return entryLocation(
    readProjectWorkDirEntriesSafely().find((entry) => entry.id === projectId),
  );
}

/** A reference picker must not silently fall back to the server workspace. */
export function resolveRegisteredProjectWorkDir(projectId: string): string {
  const location = resolveProjectWorkspaceLocation(projectId);
  if (!location) throw new Error("The project has no registered workspace.");
  return workspaceLocationHostPath(canonicalizeWorkspaceLocationSync(location));
}

export function tryResolveSessionWorkspaceLocation(
  sessionId: string,
  projectId: string,
): WorkspaceLocation | undefined {
  const binding = agentRuntimeStore.tryGetSession(sessionId)?.sessionMetadata
    ?.backend as
    | {
        workspaceLocation?: WorkspaceLocation;
        workDir?: string | null;
      }
    | undefined;
  if (binding?.workspaceLocation) return binding.workspaceLocation;
  if (binding?.workDir)
    return (
      parseWslUncPath(binding.workDir) ?? {
        kind: "host",
        path: binding.workDir,
      }
    );
  const transient = tryGetSessionWorkspaceRoot(sessionId);
  if (transient)
    return parseWslUncPath(transient) ?? { kind: "host", path: transient };
  return resolveProjectWorkspaceLocation(projectId);
}

export function resolveSessionWorkspaceLocation(
  sessionId: string,
  projectId: string,
): WorkspaceLocation {
  const location = tryResolveSessionWorkspaceLocation(sessionId, projectId);
  if (location) return location;
  throw new Error(
    "The session has no registered workspace. Select an existing working directory before executing.",
  );
}

/** Prefer an explicit session workspace root, then the project's registered path. */
export function resolveSessionWorkDir(
  sessionId: string,
  projectId: string,
): string {
  const bound = tryGetSessionWorkspaceRoot(sessionId);
  if (bound) return bound;
  try {
    return workspaceLocationHostPath(
      resolveSessionWorkspaceLocation(sessionId, projectId),
    );
  } catch {
    return resolveProjectWorkDir(projectId);
  }
}

/** A persisted membership snapshot also works in session worker processes. */
export function resolveSessionWorkspaceRoots(
  sessionId: string,
  projectId: string,
): ProjectWorkspaceRoot[] {
  const binding = agentRuntimeStore.tryGetSession(sessionId)?.sessionMetadata
    ?.backend as { workspaceRoots?: ProjectWorkspaceRoot[] } | undefined;
  if (binding?.workspaceRoots) return binding.workspaceRoots;
  const project = readWorkspaceProject(projectId);
  if (project) return projectWorkspaceRoots(project);
  const location = tryResolveSessionWorkspaceLocation(sessionId, projectId) ?? {
    kind: "host" as const,
    path: resolveProjectWorkDir(projectId),
  };
  return [
    {
      id: projectId,
      name: projectId,
      path: location.path,
      location,
      role: "primary",
      status: "available",
    },
  ];
}

/** Freeze the real execution root before accepting work; never infer it from server cwd. */
export function bindSessionWorkDir(sessionId: string): string {
  const session = agentRuntimeStore.getSession(sessionId);
  const binding = session.sessionMetadata?.backend as
    | {
        workDir?: string | null;
        workspaceLocation?: WorkspaceLocation;
        workspaceRoots?: ProjectWorkspaceRoot[];
      }
    | undefined;
  const location = canonicalizeWorkspaceLocationSync(
    resolveSessionWorkspaceLocation(sessionId, session.projectId),
  );
  const root = workspaceLocationHostPath(location);
  const previous = binding?.workspaceRoots;
  const project = readWorkspaceProject(session.projectId);
  const roots =
    (session.activeRunId || session.parentSessionId) && previous
      ? previous
      : project
        ? projectWorkspaceRoots(project)
        : [
            {
              id: session.projectId,
              name: session.projectId,
              path: location.path,
              location,
              role: "primary" as const,
              status: "available" as const,
            },
          ];
  const workspaceRoots = roots.map((item) => {
    const canonical = canonicalizeWorkspaceLocationSync(
      item.location ?? { kind: "host", path: item.path },
    );
    const normalized: ProjectWorkspaceRoot = {
      ...item,
      path: canonical.path,
      location: canonical,
      status: "available" as const,
    };
    if (canonical.kind === "host")
      Object.defineProperty(normalized, "location", {
        configurable: true,
        enumerable: false,
        value: canonical,
      });
    return normalized;
  });
  setSessionWorkspaceRoot(sessionId, root);
  agentRuntimeStore.updateSessionMetadata(sessionId, {
    backend: {
      ...binding,
      workDir: root,
      workspaceLocation: location,
      workspaceRoots,
    },
  });
  return root;
}

function readProjectWorkDirEntriesSafely(): ProjectWorkDirEntry[] {
  try {
    return readProjectWorkDirEntries();
  } catch {
    return [];
  }
}

export function clearSessionWorkspaceRoot(sessionId: string): void {
  sessionWorkspaceRoots.delete(sessionId);
}

function workspaceRootForSession(sessionId?: string): string {
  return workspaceRoot(sessionId);
}

/**
 * Resolve a tool path. Non-unrestricted sessions stay inside the workspace and
 * keep the remaining sandbox rules; unrestricted sessions resolve anywhere.
 */
export function resolveWorkspacePath(
  inputPath = ".",
  sessionId?: string,
): string {
  const root = workspaceRootForSession(sessionId);
  return sandboxPolicy.resolve(
    inputPath,
    root,
    sessionId ?? "__default__",
    "workspace",
  );
}

export function toWorkspaceRelative(
  absPath: string,
  sessionId?: string,
): string {
  let root = workspaceRootForSession(sessionId);
  try {
    root = fs.realpathSync(root);
  } catch {
    /* keep as-is */
  }
  const relative = path.relative(root, absPath).replace(/\\/g, "/");
  if (!relative) return ".";
  // Unrestricted sessions can leave the root; show the absolute path instead of `..` chains.
  if (relative === ".." || relative.startsWith("../")) {
    return path.isAbsolute(absPath) ? absPath.replace(/\\/g, "/") : relative;
  }
  return relative;
}

/**
 * Listings hide only what the session's sandbox still denies. Segment names such
 * as `.env`, `.git`, `.ssh`, `node_modules`, `dist` and `build` are no longer
 * restricted; only the remaining blocked extensions are, and unrestricted
 * sessions hide nothing.
 */
export function isWorkspaceEntryVisible(
  name: string,
  sessionId?: string | null,
): boolean {
  const config = sandboxConfigForSession(sessionId ?? "__default__");
  if (config.unrestricted) return true;
  const ext = path.extname(name).toLowerCase();
  return !(ext && config.blockedExtensions.has(ext));
}

export function isWorkspaceRelativePathBlocked(
  relativePath: string,
  sessionId?: string | null,
): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") return false;
  return !isWorkspaceEntryVisible(path.posix.basename(normalized), sessionId);
}
