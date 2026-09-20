import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "../lib/env.js";
import {
  assertCompatibleLocations,
  canonicalHostDirectory,
  canonicalizeWorkspaceLocation,
  canonicalizeWorkspaceLocationSync,
  hostWorkspaceLocation,
  locationContains,
  type WorkspaceLocation,
  workspaceLocationHostPath,
} from "./workspace-location.js";

export interface ProjectReference {
  id: string;
  name: string;
  /** Legacy host workspace field. */
  localPath?: string;
  /** Canonical location for WSL roots and new API clients. */
  location?: WorkspaceLocation;
}

export interface WorkspaceProject {
  id: string;
  name?: string;
  primaryName?: string;
  source?: {
    kind?: string;
    localPath?: string;
    distribution?: string;
    path?: string;
  };
  references?: ProjectReference[];
}

export interface ProjectWorkspaceRoot {
  id: string;
  name: string;
  /** User-facing path: host absolute path or Linux absolute path. */
  path: string;
  location?: WorkspaceLocation;
  role: "primary" | "reference";
  status: "available" | "missing";
  /** Internal-only filesystem path; deliberately non-enumerable on generated roots. */
  hostPath?: string;
}

export function canonicalWorkspaceDirectory(input: string): string {
  return canonicalHostDirectory(input);
}

export function isWithinWorkspace(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function projectSourceLocation(
  project: WorkspaceProject,
): WorkspaceLocation | undefined {
  const source = project.source;
  if (!source) return undefined;
  if (source.kind === "wsl" && source.distribution && source.path) {
    return {
      kind: "wsl",
      distribution: source.distribution,
      path: source.path,
    };
  }
  if (source.localPath) return hostWorkspaceLocation(source.localPath);
  return undefined;
}

export function projectReferenceLocation(
  reference: ProjectReference,
): WorkspaceLocation | undefined {
  return (
    reference.location ??
    (reference.localPath
      ? hostWorkspaceLocation(reference.localPath)
      : undefined)
  );
}

export function workspaceRootLocation(
  root: ProjectWorkspaceRoot,
): WorkspaceLocation {
  return root.location ?? hostWorkspaceLocation(root.path);
}

export function workspaceRootHostPath(root: ProjectWorkspaceRoot): string {
  return (
    root.hostPath ?? workspaceLocationHostPath(workspaceRootLocation(root))
  );
}

function withInternalHostPath(
  root: ProjectWorkspaceRoot,
): ProjectWorkspaceRoot {
  const location = workspaceRootLocation(root);
  if (location.kind === "host") {
    Object.defineProperty(root, "location", {
      configurable: true,
      enumerable: false,
      value: location,
    });
  }
  Object.defineProperty(root, "hostPath", {
    configurable: true,
    enumerable: false,
    value: workspaceLocationHostPath(location),
  });
  return root;
}

export function projectWorkspaceRoots(
  project: WorkspaceProject,
): ProjectWorkspaceRoot[] {
  const roots: Array<
    Omit<ProjectWorkspaceRoot, "status" | "path"> & {
      location: WorkspaceLocation;
    }
  > = [];
  const primary = projectSourceLocation(project);
  if (primary)
    roots.push({
      id: project.id,
      name: project.primaryName ?? project.name ?? project.id,
      location: primary,
      role: "primary",
    });
  for (const reference of project.references ?? []) {
    const location = projectReferenceLocation(reference);
    if (location)
      roots.push({
        id: reference.id,
        name: reference.name,
        location,
        role: "reference",
      });
  }
  return roots.map((input) => {
    try {
      const location = canonicalizeWorkspaceLocationSync(input.location);
      return withInternalHostPath({
        ...input,
        location,
        path: location.path,
        status: "available",
      });
    } catch {
      return withInternalHostPath({
        ...input,
        path: input.location.path,
        status: "missing",
      });
    }
  });
}

export function readWorkspaceProject(
  projectId: string,
): WorkspaceProject | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(DATA_ROOT, "projects.json"), "utf8"),
    );
    const items: WorkspaceProject[] = Array.isArray(raw)
      ? raw
      : (raw.items ?? []);
    return items.find((project) => project.id === projectId);
  } catch {
    return undefined;
  }
}

/** Validate a new membership against canonical host/WSL locations. */
export async function validateProjectReferenceLocation(
  project: WorkspaceProject,
  input: WorkspaceLocation,
): Promise<WorkspaceLocation> {
  const primary = projectSourceLocation(project);
  if (!primary)
    throw new Error(
      "The main project must have a local workspace before adding references.",
    );
  const existingLocations = projectWorkspaceRoots(project).map(
    workspaceRootLocation,
  );
  assertCompatibleLocations([primary, input]);
  const candidate = await canonicalizeWorkspaceLocation(input);
  assertCompatibleLocations([...existingLocations, candidate]);
  for (const root of projectWorkspaceRoots(project)) {
    const existing = workspaceRootLocation(root);
    if (
      locationContains(existing, candidate) ||
      locationContains(candidate, existing)
    ) {
      throw new Error(
        `Workspace directories must not duplicate or overlap: ${root.name}`,
      );
    }
  }
  return candidate;
}

/** Legacy synchronous host-path validator retained for callers and tests. */
export function validateProjectReference(
  project: WorkspaceProject,
  input: string,
): string {
  const primary = projectSourceLocation(project);
  if (!primary || primary.kind !== "host")
    throw new Error(
      "The main project must have a local workspace before adding references.",
    );
  canonicalWorkspaceDirectory(primary.path);
  const candidate = canonicalWorkspaceDirectory(input);
  for (const root of projectWorkspaceRoots(project)) {
    const location = workspaceRootLocation(root);
    if (location.kind !== "host")
      throw new Error("Workspace roots must use the same environment.");
    const existing = path.resolve(location.path);
    if (
      isWithinWorkspace(existing, candidate) ||
      isWithinWorkspace(candidate, existing)
    ) {
      throw new Error(
        `Workspace directories must not duplicate or overlap: ${root.name}`,
      );
    }
  }
  return candidate;
}
