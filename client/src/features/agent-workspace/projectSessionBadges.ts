import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  agentRuntimeApi,
  type SessionBadgeRow,
} from "../../adapters/transport/agentRuntime";
import { subscribe } from "../../adapters/transport/runtimeEventBus";
import { ProjectBadgeRefresh } from "./projectBadgeRefresh";
import { loadReadMarkers, useAgentSessionStore } from "./state/agentSessionStore";

const RUNNING_SESSION_STATUS = "running";

const COMPLETED_SESSION_STATUSES = new Set<string>([
  "completed",
  "failed",
]);


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
  const refreshOwner = useRef<ProjectBadgeRefresh<{ items: SessionBadgeRow[] }> | null>(null);

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

  const refresh = useCallback(() => refreshOwner.current?.refresh() ?? Promise.resolve(), []);

  useEffect(() => {
    if (stableProjectIds.length <= 1) {
      setSessionsByProject({});
      return;
    }
    let rows = new Map<string, SessionBadgeRow>();
    const owner = new ProjectBadgeRefresh(
      () => agentRuntimeApi.listSessionBadges(stableProjectIds),
      ({ items }) => {
        rows = new Map(items.map(row => [row.id, row]));
        const grouped: Record<string, SessionBadgeRow[]> = Object.fromEntries(stableProjectIds.map(id => [id, []]));
        for (const row of items) if (row.projectId in grouped) grouped[row.projectId].push(row);
        setNow(Date.now());
        setSessionsByProject(grouped);
      },
    );
    refreshOwner.current = owner;
    const invalidate = () => owner.invalidate();
    const changed = (event: MessageEvent) => {
      try {
        const { sessionId, patch } = JSON.parse(event.data);
        if (!patch || typeof patch !== "object") { invalidate(); return; }
        const metadata = patch.sessionMetadata;
        if (metadata && ["archivedAt", "deletedAt", "forkPreparing", "runtimeControl"].some(key => key in metadata)) {
          invalidate(); return;
        }
        if ("projectId" in patch || "parentSessionId" in patch) { invalidate(); return; }
        const row = rows.get(sessionId);
        // Token/metadata-only updates of an active session cannot change its badge.
        if ("status" in patch && (!row || patch.status !== row.status)) { invalidate(); return; }
        if (row && COMPLETED_SESSION_STATUSES.has(row.status) && "updatedAt" in patch && patch.updatedAt !== row.updatedAt)
          invalidate();
      } catch { invalidate(); }
    };
    const unsubscribe = subscribe({
      onConnect: invalidate,
      events: {
        session_created: invalidate,
        session_changed: changed,
        session_deleted: invalidate,
        session_archived: invalidate,
      },
    });
    void owner.refresh();
    return () => {
      unsubscribe();
      owner.dispose();
      if (refreshOwner.current === owner) refreshOwner.current = null;
    };
  }, [stableProjectIds]);

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
