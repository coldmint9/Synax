/**
 * Remembers the workspace the user was last in so a fresh app start can route
 * back to it instead of guessing from project metadata.
 *
 * `updatedAt` only says when project data changed (a session run in another
 * workspace bumps it), so it cannot answer "where did I close the app?".
 */
const STORAGE_KEY = "synax.lastOpenedWorkspace";

function storage(): Storage | null {
  if (typeof globalThis === "undefined" || !("localStorage" in globalThis)) {
    return null;
  }
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function loadLastOpenedWorkspaceId(): string | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const id = raw.trim();
    return id || null;
  } catch {
    return null;
  }
}

export function saveLastOpenedWorkspaceId(workspaceId: string): void {
  if (!workspaceId) return;
  const store = storage();
  if (!store) return;
  try {
    if (store.getItem(STORAGE_KEY) === workspaceId) return;
    store.setItem(STORAGE_KEY, workspaceId);
  } catch {
    /* quota or unavailable storage */
  }
}

/**
 * Drop the remembered workspace, or only when it still points at `workspaceId`
 * so a stale name cannot clear a newer workspace remembered in another window.
 */
export function clearLastOpenedWorkspaceId(workspaceId?: string): void {
  const store = storage();
  if (!store) return;
  try {
    if (workspaceId && store.getItem(STORAGE_KEY) !== workspaceId) return;
    store.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

interface WorkspaceCandidate {
  id: string;
  updatedAt?: string;
}

function updatedAtMs(value: string | undefined): number {
  if (!value) return 0;
  if (value === "just now") return Date.now();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Startup target: the remembered workspace, or — when it was deleted or never
 * recorded — the most recently updated one, which is the closest approximation
 * available before the user picks a workspace again.
 */
export function resolveStartupWorkspaceId(
  projects: readonly WorkspaceCandidate[],
  lastOpenedId: string | null = loadLastOpenedWorkspaceId(),
): string | null {
  if (projects.length === 0) return null;
  if (lastOpenedId && projects.some((project) => project.id === lastOpenedId)) {
    return lastOpenedId;
  }
  let candidate = projects[0];
  for (const project of projects) {
    if (updatedAtMs(project.updatedAt) > updatedAtMs(candidate.updatedAt)) {
      candidate = project;
    }
  }
  return candidate.id;
}
