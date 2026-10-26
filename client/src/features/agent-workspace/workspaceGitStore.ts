import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  agentRuntimeApi,
  type WorkspaceRepositoryGit,
} from "../../adapters/transport/agentRuntime";
import { subscribe } from "../../adapters/transport/runtimeEventBus";
import { useWorkbenchPageActive } from "../../app/layouts/CachedWorkbenchPage";

/**
 * Workspace-scoped Git cache (client L1).
 *
 * Git facts belong to a checkout, not to a conversation, so this store is keyed
 * by project and optional session binding, so an isolated worktree cannot reuse
 * the default checkout's facts. Requests are conditional on the revision, so a
 * quiet checkout costs one tiny `unchanged` response instead of a file list.
 */

/** External editors publish no runtime events; keep a slow drift safety net. */
const SLOW_REFRESH_MS = 120_000;
const EVENT_BATCH_MS = 250;
const RESUME_STALE_MS = 30_000;
const MAX_WORKSPACES = 8;

export interface WorkspaceGitSnapshot {
  projectId: string;
  revision: string;
  repositories: WorkspaceRepositoryGit[];
  refreshedAt: string;
}

const snapshots = new Map<string, WorkspaceGitSnapshot>();
/** Last successful validation per workspace; kept outside the snapshot so a
 *  revalidation does not change the object React already painted. */
const checkedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<WorkspaceGitSnapshot | null>>();
const listeners = new Set<() => void>();

function workspaceKey(projectId: string, sessionId?: string): string {
  return sessionId ? JSON.stringify([projectId, sessionId]) : projectId;
}

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeWorkspaceGit(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWorkspaceGitSnapshot(
  projectId: string | null | undefined,
  sessionId?: string,
): WorkspaceGitSnapshot | null {
  return projectId ? (snapshots.get(workspaceKey(projectId, sessionId)) ?? null) : null;
}

/**
 * Keep the previous object for every repository whose revision did not change,
 * so a single edited project does not re-render the other members.
 */
function mergeRepositories(
  previous: WorkspaceRepositoryGit[] | undefined,
  next: WorkspaceRepositoryGit[],
): WorkspaceRepositoryGit[] {
  if (!previous || previous.length === 0) return next;
  const byRoot = new Map(previous.map((item) => [item.rootId, item]));
  let changed = previous.length !== next.length;
  const merged = next.map((item) => {
    const old = byRoot.get(item.rootId);
    if (old && old.revision === item.revision && old.workspacePath === item.workspacePath) return old;
    changed = true;
    return item;
  });
  return changed ? merged : previous;
}

function storeSnapshot(key: string, snapshot: WorkspaceGitSnapshot): WorkspaceGitSnapshot {
  const previous = snapshots.get(key);
  checkedAt.set(key, Date.now());
  if (
    previous &&
    previous.revision === snapshot.revision &&
    previous.repositories === snapshot.repositories
  )
    return previous;
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  while (snapshots.size > MAX_WORKSPACES) {
    const oldest = snapshots.keys().next().value!;
    if (oldest === key) break;
    snapshots.delete(oldest);
    checkedAt.delete(oldest);
  }
  emit();
  return snapshot;
}

/**
 * Shared loader. Readers within `maxAgeMs` reuse the snapshot, concurrent
 * readers join one request, and the request only carries the revision.
 */
export function loadWorkspaceGit(
  projectId: string | null | undefined,
  options?: { maxAgeMs?: number; force?: boolean; sessionId?: string },
): Promise<WorkspaceGitSnapshot | null> {
  if (!projectId) return Promise.resolve(null);
  const key = workspaceKey(projectId, options?.sessionId);
  const maxAge = options?.maxAgeMs ?? 0;
  const checked = checkedAt.get(key);
  if (!options?.force && checked !== undefined && Date.now() - checked < maxAge)
    return Promise.resolve(snapshots.get(key) ?? null);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = agentRuntimeApi
    .getWorkspaceGitChanges(projectId, {
      sessionId: options?.sessionId,
      revision: snapshots.get(key)?.revision,
    })
    .then((next) => {
      if (inFlight.get(key) !== request) return snapshots.get(key) ?? null;
      const previous = snapshots.get(key);
      const repositories = next.unchanged
        ? (previous?.repositories ?? [])
        : mergeRepositories(previous?.repositories, next.repositories);
      return storeSnapshot(key, {
        projectId,
        revision: next.revision,
        repositories,
        refreshedAt: next.refreshedAt,
      });
    })
    .finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** Force the next read to revalidate; painted data stays on screen. */
export function invalidateWorkspaceGit(projectId?: string | null): void {
  if (!projectId) {
    checkedAt.clear();
    return;
  }
  checkedAt.delete(projectId);
  for (const [key, snapshot] of snapshots) {
    if (snapshot.projectId === projectId) checkedAt.delete(key);
  }
}

export function resetSessionWorkspaceGit(projectId: string, sessionId: string): void {
  const key = workspaceKey(projectId, sessionId);
  snapshots.delete(key);
  checkedAt.delete(key);
  inFlight.delete(key);
  emit();
}

export function useWorkspaceGit(projectId: string | null, sessionId?: string) {
  const active = useWorkbenchPageActive();
  const snapshot = useSyncExternalStore(
    subscribeWorkspaceGit,
    () => getWorkspaceGitSnapshot(projectId, sessionId),
    () => null,
  );
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      await loadWorkspaceGit(projectId, { force: true, sessionId });
    } catch {
      // Keep the last usable snapshot; the next event or tick retries.
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    if (!projectId || !active) return;
    const key = workspaceKey(projectId, sessionId);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlightLocal: Promise<unknown> | undefined;

    const run = (): Promise<void> => {
      if (cancelled || document.hidden) return Promise.resolve();
      if (inFlightLocal) return inFlightLocal.then(() => undefined);
      clearTimeout(timer);
      setLoading(true);
      inFlightLocal = loadWorkspaceGit(projectId, { force: true, sessionId })
        .catch(() => null)
        .finally(() => {
          inFlightLocal = undefined;
          if (cancelled) return;
          setLoading(false);
          scheduleSlow();
        });
      return inFlightLocal.then(() => undefined);
    };

    const scheduleSlow = () => {
      clearTimeout(timer);
      if (cancelled || document.hidden) return;
      timer = setTimeout(() => void run(), SLOW_REFRESH_MS);
    };

    // Bursts of runtime events share one trailing revalidation.
    const markDirty = () => {
      if (cancelled) return;
      clearTimeout(timer);
      if (document.hidden) return;
      timer = setTimeout(() => void run(), EVENT_BATCH_MS);
    };

    const onRuntimeEvent = (event: MessageEvent) => {
      let payload: { projectId?: string } | null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") return;
      // Workspace events carry their project; older payloads fall back to
      // revalidating whatever this hook has loaded.
      if (payload.projectId && payload.projectId !== projectId) return;
      markDirty();
    };

    const unsubscribe = subscribe({
      events: {
        session_changed: onRuntimeEvent,
        session_step_completed: onRuntimeEvent,
        session_process_changed: onRuntimeEvent,
        session_deleted: onRuntimeEvent,
        session_archived: onRuntimeEvent,
      },
      onConnect: () => {
        if (checkedAt.has(key)) markDirty();
      },
    });

    const onVisibility = () => {
      clearTimeout(timer);
      timer = undefined;
      if (document.hidden) return;
      const checked = checkedAt.get(key);
      if (checked === undefined || Date.now() - checked >= RESUME_STALE_MS)
        void run();
      else scheduleSlow();
    };
    // A commit, restore or branch switch asks for a refresh by session id;
    // this hook only tracks the workspace, so any request revalidates it.
    const onWorkspaceRefresh = () => markDirty();

    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("workspace:refresh", onWorkspaceRefresh);

    // Paint the cached workspace immediately, then only revalidate when it is
    // older than the slow window: switching sessions is a pure cache hit.
    const checked = checkedAt.get(key);
    if (checked === undefined || Date.now() - checked >= SLOW_REFRESH_MS)
      void run();
    else scheduleSlow();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("workspace:refresh", onWorkspaceRefresh);
      unsubscribe();
    };
  }, [projectId, sessionId, active]);

  return { snapshot, repositories: snapshot?.repositories ?? [], loading, reload };
}
