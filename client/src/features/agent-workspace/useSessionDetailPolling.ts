import { useWorkbenchPageActive } from "../../app/layouts/CachedWorkbenchPage";
import { useEffect } from "react";
import { useApiConnectivityStore } from "../../shared/lib/apiConnectivity";
import { useAgentSessionStore } from "./state/agentSessionStore";

// Low-frequency safety net only: live stream events drive the fast path
// (coalesced in agentSessionStore), so this poll just catches anything the
// stream missed for the session on screen. It reads that row and its detail,
// never the page: the session list stays owned by live callbacks.
export const ACTIVE_SESSION_POLL_MS = 30_000;
const pollers = new Map<string, { users: number; stop: () => void }>();

function isDocumentHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/**
 * Poll the open session's row + detail while it is actively running.
 * A shared poller joins pending profile/transcript requests rather than restarting them.
 */
export function useSessionDetailPolling() {
  const active = useWorkbenchPageActive();
  const projectId = useAgentSessionStore((s) => s.projectId);
  const apiReachable = useApiConnectivityStore((s) => s.apiReachable);
  const refreshDetail = useAgentSessionStore((s) => s.refreshDetail);
  const syncSessionSummary = useAgentSessionStore((s) => s.syncSessionSummary);
  const fetchSessionStats = useAgentSessionStore((s) => s.fetchSessionStats);
  const fetchSessionTodos = useAgentSessionStore((s) => s.fetchSessionTodos);
  const fetchSessionInvocationUsage = useAgentSessionStore((s) => s.fetchSessionInvocationUsage);
  const panelOpen = useAgentSessionStore((s) => s.panelOpen);
  const selectedSessionId = useAgentSessionStore((s) => s.selectedSessionId);
  const selectedStatus = useAgentSessionStore((s) => {
    const id = s.selectedSessionId;
    return id ? s.sessions.find((sess) => sess.id === id)?.status : undefined;
  });

  useEffect(() => {
    if (!active || apiReachable === "unreachable") return;
    if (!panelOpen || !selectedSessionId) return;
    const isActive =
      selectedStatus === "running" ||
      selectedStatus === "waiting_permission" ||
      selectedStatus === "waiting_input";
    if (!isActive) return;

    const sessionId = selectedSessionId;
    const key = JSON.stringify([projectId, sessionId, selectedStatus]);
    const existing = pollers.get(key);
    const release = () => {
      const poller = pollers.get(key);
      if (poller && --poller.users === 0) {
        poller.stop();
        pollers.delete(key);
      }
    };
    if (existing) {
      existing.users++;
      return release;
    }

    let cancelled = false;
    let inFlight = false;
    let timer: number | null = null;

    function clearTimer() {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    }

    function schedule() {
      clearTimer();
      if (cancelled || isDocumentHidden()) return;
      timer = window.setTimeout(tick, ACTIVE_SESSION_POLL_MS);
    }

    function startRefresh() {
      inFlight = true;
      const cache = useAgentSessionStore.getState().sessionDetailCache[sessionId];
      const needsDetail =
        !cache?.cachedAt ||
        cache.invalidated === true ||
        cache.restored === "active";
      const requests: Promise<unknown>[] = [syncSessionSummary(sessionId)];
      if (needsDetail)
        requests.push(refreshDetail({ joinPending: true, background: true }));
      else
        requests.push(fetchSessionStats(), fetchSessionTodos(), fetchSessionInvocationUsage());
      void Promise.allSettled([
        // A single row remains cheap; transcript detail only runs when the
        // cache is cold or has been invalidated by a content change.
        ...requests,
      ]).finally(() => {
        inFlight = false;
        schedule();
      });
    }

    function tick() {
      clearTimer();
      if (cancelled || isDocumentHidden()) return;
      if (inFlight) {
        schedule();
        return;
      }
      startRefresh();
    }

    function handleVisibilityChange() {
      if (cancelled) return;
      if (isDocumentHidden()) {
        clearTimer();
        return;
      }
      tick();
    }

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    if (!isDocumentHidden()) startRefresh();

    const stop = () => {
      cancelled = true;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
      }
    };
    pollers.set(key, { users: 1, stop });
    return release;
  }, [
    active,
    projectId,
    apiReachable,
    panelOpen,
    selectedSessionId,
    selectedStatus,
    refreshDetail,
    syncSessionSummary,
    fetchSessionStats,
    fetchSessionTodos,
    fetchSessionInvocationUsage,
  ]);
}
