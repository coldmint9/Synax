import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentRuntimeApi,
  type SessionBadgeRow,
} from "../../adapters/transport/agentRuntime";
import { subscribe } from "../../adapters/transport/runtimeEventBus";
import { loadReadMarkers, useAgentSessionStore } from "./state/agentSessionStore";

const RUNNING_SESSION_STATUS = "running";

const COMPLETED_SESSION_STATUSES = new Set<string>([
  "completed",
  "failed",
]);

const EVENT_REFRESH_DEBOUNCE_MS = 300;
const PROJECT_BADGE_VIEWED_KEY = "synax.projectBadgeViewedAt";

function loadProjectBadgeViewedAt(projectId: string): number {
  try {
    const value = Number(localStorage.getItem(`${PROJECT_BADGE_VIEWED_KEY}:${projectId}`));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export interface ProjectSessionBadge {
  waitingInput: number;
  unreadFailed: number;
  running: number;
  unreadCompleted: number;
  total: number;
}

export interface ProjectSessionActivity {
  status: "waiting" | "failed" | "running" | "unread";
  count: number;
}

export function projectSessionActivity(badge?: ProjectSessionBadge): ProjectSessionActivity | undefined {
  if (!badge) return undefined;
  if (badge.waitingInput > 0) return { status: "waiting", count: badge.waitingInput };
  if (badge.unreadFailed > 0) return { status: "failed", count: badge.unreadFailed };
  if (badge.running > 0) return { status: "running", count: badge.running };
  if (badge.unreadCompleted > 0) return { status: "unread", count: badge.unreadCompleted };
  return undefined;
}

interface ProjectSessionBadgeInput {
  sessions: readonly SessionBadgeRow[];
  readMarkers: Readonly<Record<string, string>>;
  now: number;
  viewedAt?: number;
}

export function projectSessionBadge({
  sessions,
  readMarkers,
  now,
  viewedAt = 0,
}: ProjectSessionBadgeInput): ProjectSessionBadge {
  let running = 0;
  let unreadCompleted = 0;
  let waitingInput = 0;
  let unreadFailed = 0;

  for (const session of sessions) {
    const updatedAt = Date.parse(session.updatedAt);
    if (updatedAt <= viewedAt) continue;
    if (session.status === RUNNING_SESSION_STATUS) {
      running += 1;
      continue;
    }
    if (session.status === "waiting_input" || session.status === "waiting_permission") {
      waitingInput += 1;
      continue;
    }
    if (!COMPLETED_SESSION_STATUSES.has(session.status)) continue;

    const readMarker = readMarkers[session.id];
    const unread = readMarker
      ? updatedAt > Date.parse(readMarker)
      : Number.isFinite(updatedAt) && updatedAt <= now;
    if (unread) {
      if (session.status === "failed") unreadFailed += 1;
      else unreadCompleted += 1;
    }
  }

  return {
    running,
    unreadCompleted,
    waitingInput,
    unreadFailed,
    total: running + unreadCompleted + waitingInput + unreadFailed,
  };
}

export interface ProjectSessionBadgesResult {
  badges: Readonly<Record<string, ProjectSessionBadge>>;
  refresh: () => Promise<void>;
}

export function useProjectSessionBadges(
  projectIds: readonly string[],
  currentProjectId: string,
): ProjectSessionBadgesResult {
  const projectKey = JSON.stringify(
    [...new Set(projectIds.filter(Boolean))].sort(),
  );
  const stableProjectIds = useMemo<string[]>(
    () => JSON.parse(projectKey),
    [projectKey],
  );
  const readMarkers = useAgentSessionStore((state) => state.readSessionMarkers);
  const activeProjectId = useAgentSessionStore((state) => state.projectId);
  const readMarkersByProject = useMemo(() => Object.fromEntries(
    stableProjectIds.map((projectId) => [
      projectId,
      projectId === activeProjectId ? readMarkers : loadReadMarkers(projectId),
    ]),
  ), [activeProjectId, readMarkers, stableProjectIds]);
  const [sessionsByProject, setSessionsByProject] = useState<
    Record<string, SessionBadgeRow[]>
  >({});
  const [now, setNow] = useState(() => Date.now());
  const [viewedAtByProject, setViewedAtByProject] = useState<Record<string, number>>({});
  const requestVersion = useRef(0);
  const eventRefreshTimer = useRef<number | null>(null);

  const markProjectViewed = useCallback((projectId: string) => {
    const viewedAt = Date.now();
    // Workspace attention is separate from individual conversation read markers.
    // Persist synchronously so leaving/unmounting cannot bring old badges back.
    try {
      localStorage.setItem(`${PROJECT_BADGE_VIEWED_KEY}:${projectId}`, String(viewedAt));
    } catch {
      // Keep clearing badges in memory when browser storage is unavailable.
    }
    setViewedAtByProject((previous) => ({ ...previous, [projectId]: viewedAt }));
  }, []);

  useEffect(() => {
    if (!currentProjectId) return;
    markProjectViewed(currentProjectId);
    // Activity received while viewing the workspace has also been seen.
    return () => markProjectViewed(currentProjectId);
  }, [currentProjectId, markProjectViewed]);

  const clearScheduledRefresh = useCallback(() => {
    if (eventRefreshTimer.current === null) return;
    window.clearTimeout(eventRefreshTimer.current);
    eventRefreshTimer.current = null;
  }, []);

  const refresh = useCallback(async () => {
    clearScheduledRefresh();
    if (stableProjectIds.length <= 1) return;

    const version = ++requestVersion.current;
    setNow(Date.now());
    try {
      // One sparse badges query replaces per-project full list fetches: badge
      // math needs only id/status/updatedAt.
      const { items } =
        await agentRuntimeApi.listSessionBadges(stableProjectIds);
      if (requestVersion.current !== version) return;

      const nextSessionsByProject: Record<string, SessionBadgeRow[]> = {};
      for (const projectId of stableProjectIds)
        nextSessionsByProject[projectId] = [];
      for (const row of items) {
        if (row.projectId in nextSessionsByProject)
          nextSessionsByProject[row.projectId].push(row);
      }
      setSessionsByProject(nextSessionsByProject);
    } catch {
      // Project badges are best-effort; retain the last successful snapshot.
    }
  }, [clearScheduledRefresh, stableProjectIds]);

  const scheduleEventRefresh = useCallback(() => {
    if (stableProjectIds.length <= 1) return;
    clearScheduledRefresh();
    eventRefreshTimer.current = window.setTimeout(() => {
      eventRefreshTimer.current = null;
      void refresh();
    }, EVENT_REFRESH_DEBOUNCE_MS);
  }, [clearScheduledRefresh, refresh, stableProjectIds.length]);

  useEffect(() => {
    if (stableProjectIds.length <= 1) {
      clearScheduledRefresh();
      requestVersion.current += 1;
      setSessionsByProject({});
      return;
    }

    const unsubscribe = subscribe({
      onConnect: scheduleEventRefresh,
      events: {
        session_created: scheduleEventRefresh,
        session_changed: scheduleEventRefresh,
        session_deleted: scheduleEventRefresh,
        session_archived: scheduleEventRefresh,
      },
    });

    // The shared SSE connection may already be open, so synchronize once on mount.
    void refresh();

    return () => {
      unsubscribe();
      clearScheduledRefresh();
      requestVersion.current += 1;
    };
  }, [
    clearScheduledRefresh,
    refresh,
    scheduleEventRefresh,
    stableProjectIds.length,
  ]);

  const badges = useMemo(() => {
    const nextBadges: Record<string, ProjectSessionBadge> = {};
    for (const projectId of stableProjectIds) {
      nextBadges[projectId] = projectSessionBadge({
        sessions: projectId === currentProjectId ? [] : sessionsByProject[projectId] ?? [],
        readMarkers: readMarkersByProject[projectId] ?? {},
        now,
        viewedAt: viewedAtByProject[projectId] ?? loadProjectBadgeViewedAt(projectId),
      });
    }
    return nextBadges;
  }, [currentProjectId, now, readMarkersByProject, sessionsByProject, stableProjectIds, viewedAtByProject]);

  return { badges, refresh };
}
