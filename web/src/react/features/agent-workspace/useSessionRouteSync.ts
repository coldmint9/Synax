import { useEffect, useLayoutEffect } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAgentSessionStore } from "./state/agentSessionStore";
import {
  sessionPath,
  isBareSessionsPath,
  isNewSessionPath,
  newSessionPath,
} from "./sessionRoutes";
import {
  clearSessionLastVisit,
  loadSessionLastVisit,
  saveSessionLastVisit,
} from "./sessionLastVisit";
import { isRuntimeResourceRemoved } from "../../../lib/runtimeResourceRegistry";
import type { SessionListView } from "./sessionBuckets";

/** Keep agent session detail in sync with sessions URL. */
export function useSessionRouteSync(
  listView: SessionListView,
  projectId: string,
) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const openPanel = useAgentSessionStore((s) => s.openPanel);
  const resetForDraft = useAgentSessionStore(
    (s) => s.resetSessionDetailForDraft,
  );
  const closePanel = useAgentSessionStore((s) => s.closePanel);
  const storeProjectId = useAgentSessionStore((s) => s.projectId);
  const sessions = useAgentSessionStore((s) => s.sessions);
  const total = useAgentSessionStore((s) => s.sessionListTotal);
  const sessionIdFromUrl = searchParams.get("session");
  const sessionRemoved = useAgentSessionStore(() =>
    Boolean(sessionIdFromUrl && isRuntimeResourceRemoved(sessionIdFromUrl)),
  );
  const isProjectReady = Boolean(projectId) && storeProjectId === projectId;

  useEffect(() => {
    if (!isProjectReady || listView !== "sessions" || !projectId) return;
    if (sessionIdFromUrl || isNewSessionPath(location.pathname)) return;
    if (!isBareSessionsPath(location.pathname, projectId)) return;

    const last = loadSessionLastVisit(projectId);
    if (!last) return;

    if (last.kind === "new") {
      navigate(newSessionPath(projectId), { replace: true });
      return;
    }

    if (isRuntimeResourceRemoved(last.sessionId)) {
      clearSessionLastVisit(projectId);
      return;
    }

    if (total !== null && sessions.length >= total) {
      const exists = sessions.some((s) => s.id === last.sessionId);
      if (!exists) {
        clearSessionLastVisit(projectId);
        return;
      }
    }

    navigate(sessionPath(projectId, last.sessionId), { replace: true });
  }, [
    isProjectReady,
    listView,
    location.pathname,
    projectId,
    sessionIdFromUrl,
    sessions,
    total,
    navigate,
  ]);

  useLayoutEffect(() => {
    // Child effects run before the layout's, which is what binds `projectId`
    // into the store. Right after a project switch the store therefore still
    // holds the previous project, so opening the panel here would select a
    // session that the layout's setProjectId then wipes (it resets
    // selectedSessionId/panelOpen). None of this effect's dependencies change
    // afterwards, so the panel would never reopen and the detail never loads.
    // Wait until the store has bound the project this page renders.
    if (!isProjectReady) return;

    if (sessionRemoved && (listView === "sessions" || listView === "workflow")) {
      const last = loadSessionLastVisit(projectId);
      if (last?.kind === "session" && last.sessionId === sessionIdFromUrl) {
        clearSessionLastVisit(projectId);
      }
      const search = new URLSearchParams(location.search);
      search.delete("session");
      navigate(
        { pathname: location.pathname, search: search.toString() },
        { replace: true },
      );
      return;
    }

    if (listView === "workflow") {
      if (sessionIdFromUrl) {
        openPanel(sessionIdFromUrl);
        return;
      }
      closePanel();
      return;
    }

    if (listView !== "sessions") {
      closePanel();
      return;
    }

    if (isNewSessionPath(location.pathname)) {
      if (projectId) saveSessionLastVisit(projectId, { kind: "new" });
      resetForDraft();
      return;
    }

    if (sessionIdFromUrl) {
      if (projectId) {
        saveSessionLastVisit(projectId, {
          kind: "session",
          sessionId: sessionIdFromUrl,
        });
      }
      openPanel(sessionIdFromUrl);
      return;
    }

    if (isBareSessionsPath(location.pathname, projectId || undefined)) {
      closePanel();
    }
  }, [
    isProjectReady,
    listView,
    location.pathname,
    sessionIdFromUrl,
    sessionRemoved,
    location.search,
    projectId,
    navigate,
    openPanel,
    resetForDraft,
    closePanel,
  ]);
}
