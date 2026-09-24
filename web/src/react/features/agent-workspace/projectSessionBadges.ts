import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentRuntimeApi,
  type SessionBadgeRow,
} from "../../../lib/api/agentRuntime";
import { subscribe } from "../../../lib/api/runtimeEventBus";
import { useAgentSessionStore } from "./state/agentSessionStore";

const RUNNING_SESSION_STATUS = "running";

const COMPLETED_SESSION_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const NEW_COMPLETION_WINDOW_MS = 120_000;
const EVENT_REFRESH_DEBOUNCE_MS = 300;

export interface ProjectSessionBadge {
  running: number;
  unreadCompleted: number;
  total: number;
}

interface ProjectSessionBadgeInput {
  sessions: readonly SessionBadgeRow[];
  readMarkers: Readonly<Record<string, string>>;
  now: number;
}

export function projectSessionBadge({
  sessions,
  readMarkers,
  now,
}: ProjectSessionBadgeInput): ProjectSessionBadge {
  let running = 0;
  let unreadCompleted = 0;

  for (const session of sessions) {
    if (session.status === RUNNING_SESSION_STATUS) {
      running += 1;
      continue;
    }
    if (!COMPLETED_SESSION_STATUSES.has(session.status)) continue;

    const readMarker = readMarkers[session.id];
    if (readMarker) {
      if (readMarker !== session.updatedAt) unreadCompleted += 1;
      continue;
    }

    const updatedAt = Date.parse(session.updatedAt);
    const age = now - updatedAt;
    if (
      Number.isFinite(updatedAt) &&
      age >= 0 &&
      age <= NEW_COMPLETION_WINDOW_MS
    ) {
      unreadCompleted += 1;
    }
  }

  return {
    running,
    unreadCompleted,
    total: running + unreadCompleted,
  };
}

export interface ProjectSessionBadgesResult {
  badges: Readonly<Record<string, ProjectSessionBadge>>;
  refresh: () => Promise<void>;
}

export function useProjectSessionBadges(
  projectIds: readonly string[],
): ProjectSessionBadgesResult {
  const projectKey = JSON.stringify(
    [...new Set(projectIds.filter(Boolean))].sort(),
  );
  const stableProjectIds = useMemo<string[]>(
    () => JSON.parse(projectKey),
    [projectKey],
  );
  const readMarkers = useAgentSessionStore((state) => state.readSessionMarkers);
  const [sessionsByProject, setSessionsByProject] = useState<
    Record<string, SessionBadgeRow[]>
  >({});
  const [now, setNow] = useState(() => Date.now());
  const requestVersion = useRef(0);
  const eventRefreshTimer = useRef<number | null>(null);

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

  useEffect(() => {
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const sessions of Object.values(sessionsByProject)) {
      for (const session of sessions) {
        if (
          !COMPLETED_SESSION_STATUSES.has(session.status) ||
          readMarkers[session.id]
        )
          continue;
        const updatedAt = Date.parse(session.updatedAt);
        if (!Number.isFinite(updatedAt) || updatedAt > now) continue;
        const expiry = updatedAt + NEW_COMPLETION_WINDOW_MS + 1;
        if (expiry >= now) nextExpiry = Math.min(nextExpiry, expiry);
      }
    }
    if (!Number.isFinite(nextExpiry)) return;

    const timeout = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, nextExpiry - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [now, readMarkers, sessionsByProject]);

  const badges = useMemo(() => {
    const nextBadges: Record<string, ProjectSessionBadge> = {};
    for (const projectId of stableProjectIds) {
      nextBadges[projectId] = projectSessionBadge({
        sessions: sessionsByProject[projectId] ?? [],
        readMarkers,
        now,
      });
    }
    return nextBadges;
  }, [now, readMarkers, sessionsByProject, stableProjectIds]);

  return { badges, refresh };
}
