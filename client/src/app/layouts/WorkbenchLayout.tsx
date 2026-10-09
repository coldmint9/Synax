import type { SessionNotificationTarget } from "../../shared/lib/notifications/sessionNotifications";
import { TerminalDrawer } from "../../features/terminal/TerminalDrawer";
import { lazy, Suspense, useEffect, useState, useCallback, useRef } from "react";
import { Outlet, useNavigate, useParams, useLocation } from "react-router-dom";
import { agentRuntimeApi } from "../../adapters/transport/agentRuntime";
import { projectApi } from "../../adapters/transport/project";
import { addProject, useShellStore } from "../../shared/state/shellStore";
import { useAgentDockStore } from "../../features/agent-workspace/state/agentDockStore";
import { useContextStore } from "../../shared/state/contextStore";
import { useContextStream } from "../../shared/hooks/useContextStream";
import { useAgentPermissionNotifier } from "../../shared/hooks/useAgentPermissionNotifier";
import { useDesktopNotification } from "../../shared/hooks/useDesktopNotification";
import { useTaskNotificationListener } from "../../shared/hooks/useTaskNotificationListener";
import { useRuntimeSSE } from "../../features/agent-workspace/useRuntimeSSE";
import { useAgentSessionStore } from "../../features/agent-workspace/state/agentSessionStore";
import {
  useSessionWorkspace,
  useSessionWorkspaceStore,
} from "../../features/agent-workspace/state/sessionWorkspaceStore";
import { sessionPath } from "../../features/agent-workspace/sessionRoutes";
import { resolveSessionsEntryPath } from "../../features/agent-workspace/sessionLastVisit";
import type { ActivityPanel } from "./ActivityBar";
import { WorkbenchHeader, type ChromeMode } from "./WorkbenchHeader";
import { WorkbenchIslandProvider } from "./WorkbenchIsland";
import { GitToolbarProvider } from "../../features/git/GitToolbarPortal";
import { ProjectCreateDialog } from "../../features/project-create/ProjectCreateDialog";
import { ToastContainer } from "../../shared/ui/ToastContainer";
import { CachedWorkbenchPage, PageLoading } from "./CachedWorkbenchPage";
import { setSessionDetailsVisible } from "../../features/agent-workspace/state/agentSessionStore";
const SessionsPage = lazy(() => import("../pages/SessionsPage"));
import { SessionEnvironmentProvider } from "../../features/agent-workspace/SessionEnvironmentContext";

export default function WorkbenchLayout() {
  return (
    <GitToolbarProvider>
      <WorkbenchLayoutContent />
    </GitToolbarProvider>
  );
}

function WorkbenchLayoutContent() {
  const { projectId: routeProjectId = "" } = useParams();
  const currentProjectId = useShellStore((s) => s.currentProjectId);
  const setCurrentProjectId = useShellStore((s) => s.setCurrentProjectId);
  const removingProjectIdRef = useRef<string | null>(null);

  const effectiveProjectId = routeProjectId || currentProjectId || "";
  const dockProjectRef = useRef(effectiveProjectId);
  useEffect(() => {
    if (dockProjectRef.current !== effectiveProjectId) {
      useAgentDockStore.getState().reset();
      dockProjectRef.current = effectiveProjectId;
    }
  }, [effectiveProjectId]);

  useEffect(() => {
    if (
      removingProjectIdRef.current &&
      routeProjectId !== removingProjectIdRef.current
    ) {
      removingProjectIdRef.current = null;
    }
    if (removingProjectIdRef.current === routeProjectId) return;
    if (routeProjectId && routeProjectId !== currentProjectId) {
      setCurrentProjectId(routeProjectId);
    }
  }, [routeProjectId, currentProjectId, setCurrentProjectId]);

  const projects = useShellStore((s) => s.projects);
  const projectsLoaded = useShellStore((s) => s.projectsLoaded);
  const fetchProjects = useShellStore((s) => s.fetchProjects);
  const project = projects.find((p) => p.id === effectiveProjectId) ?? null;
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  useEffect(() => {
    const open = () => setCreateDialogOpen(true);
    document.addEventListener("menu:import-project", open);
    return () => document.removeEventListener("menu:import-project", open);
  }, []);

  useEffect(() => {
    if (!projectsLoaded) void fetchProjects();
  }, [projectsLoaded, fetchProjects]);

  const bindContext = useContextStore((s) => s.bind);
  const boundProjectId = useContextStore((s) => s.projectId);
  useEffect(() => {
    if (!effectiveProjectId) return;
    if (boundProjectId !== effectiveProjectId) {
      bindContext(effectiveProjectId, "local-user");
    }
  }, [effectiveProjectId, boundProjectId, bindContext]);
  useContextStream();

  // 单例 SSE 订阅 + 绑定 projectId 到 agentSessionStore
  const setSessionProjectId = useAgentSessionStore((s) => s.setProjectId);
  useEffect(() => {
    setSessionProjectId(effectiveProjectId || null);
  }, [effectiveProjectId, setSessionProjectId]);
  useRuntimeSSE();

  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    const sync = () => setSessionDetailsVisible(location.pathname.includes("/sessions") && !document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [location.pathname]);

  const navigateToSession = useCallback(
    (sessionId: string) => {
      const session = useAgentSessionStore
        .getState()
        .sessions.find((item) => item.id === sessionId);
      if (session) navigate(sessionPath(session.projectId, sessionId));
      else
        void agentRuntimeApi
          .getSession(sessionId)
          .then(({ session }) =>
            navigate(sessionPath(session.projectId, session.id)),
          )
          .catch(() => {});
    },
    [navigate],
  );
  const dockSessionId = useAgentDockStore((s) => s.session.sessionId);
  const dockState = useAgentDockStore((s) => s.dockState);
  const visibleSessionId =
    location.pathname.includes("/sessions") &&
    !location.pathname.endsWith("/new")
      ? new URLSearchParams(location.search).get("session")
      : null;
  useAgentPermissionNotifier(
    effectiveProjectId || null,
    navigateToSession,
    visibleSessionId,
  );
  const openNotificationSession = useCallback(
    (target: SessionNotificationTarget) => {
      // Leave an inspected file/diff tab without discarding it, so the pending
      // input/approval (or completed answer) is visible in the conversation.
      useSessionWorkspaceStore.getState().showDashboard(target.sessionId);
      navigate(sessionPath(target.projectId, target.sessionId));
    },
    [navigate],
  );
  useDesktopNotification(openNotificationSession);
  useTaskNotificationListener(effectiveProjectId || null);

  useEffect(() => {
    if (!effectiveProjectId) return;
    const inStore = useShellStore
      .getState()
      .projects.some((p) => p.id === effectiveProjectId);
    if (inStore) return;
    let cancelled = false;
    void projectApi.getProject(effectiveProjectId).then((p) => {
      if (cancelled) return;
      if (p) addProject(p);
    });
    return () => {
      cancelled = true;
    };
  }, [effectiveProjectId]);

  const projectName = project?.name ?? (effectiveProjectId || "Synax");

  // Derive activePanel from current route
  const activePanel: ActivityPanel | null = (() => {
    const path = location.pathname;
    if (path.includes("/sessions")) return "sessions";
    if (path.includes("/git")) return "git";
    if (path === "/settings" || path.includes("/settings")) return "settings";
    return null;
  })();

  const selectedSessionId = useAgentSessionStore((s) => s.selectedSessionId);
  const agentPanelOpen = useAgentSessionStore((s) => s.panelOpen);
  const workspaceState = useSessionWorkspace(selectedSessionId);
  const workspaceViewerOpen = Boolean(
    activePanel === "sessions" &&
    agentPanelOpen &&
    selectedSessionId &&
    workspaceState.activeTabId,
  );
  const chromeMode: ChromeMode = workspaceViewerOpen
    ? workspaceState.presentation === "focus"
      ? "workspaceFocus"
      : "workspaceDock"
    : activePanel === "sessions" && agentPanelOpen && selectedSessionId
      ? "agentDock"
      : "global";

  const panelRoutes: Record<ActivityPanel, string> = {
    git: `/projects/${effectiveProjectId}/git`,
    sessions: resolveSessionsEntryPath(effectiveProjectId),
    settings: `/projects/${effectiveProjectId}/settings`,
    projects: `/projects/${effectiveProjectId}`,
  };

  const handlePanelToggle = (panel: ActivityPanel) => {
    if (panel === "sessions" && selectedSessionId) {
      useSessionWorkspaceStore.getState().showDashboard(selectedSessionId);
    }
    if (panel === "settings") {
      navigate("/settings");
      return;
    }
    if (effectiveProjectId) {
      navigate(panelRoutes[panel]);
    }
  };

  const isCachedPanel =
    effectiveProjectId &&
    activePanel === "sessions";

  const unbindContext = useContextStore((s) => s.unbind);
  const removeFromStore = useShellStore((s) => s.removeProject);

  const handleRemoveProject = useCallback(
    async (projectId: string) => {
      const isCurrentProject = projectId === effectiveProjectId;
      if (isCurrentProject) {
        removingProjectIdRef.current = projectId;
        unbindContext();
        setCurrentProjectId(null);
      }
      try {
        await projectApi.deleteProject(projectId);
        removeFromStore(projectId);
        if (isCurrentProject || location.pathname === `/workspaces/${encodeURIComponent(projectId)}/manage`) {
          const remaining = useShellStore.getState().projects;
          const next = remaining.find(project => project.id === effectiveProjectId) ?? remaining[0];
          if (next) {
            navigate(resolveSessionsEntryPath(next.id), {
              replace: true,
            });
          } else {
            navigate("/", { replace: true });
          }
        }
      } catch (error) {
        if (isCurrentProject) {
          removingProjectIdRef.current = null;
          setCurrentProjectId(projectId);
        }
        throw error;
      }
    },
    [
      effectiveProjectId,
      location.pathname,
      unbindContext,
      setCurrentProjectId,
      removeFromStore,
      navigate,
    ],
  );

  return (
    <SessionEnvironmentProvider
      sessionId={chromeMode === "global" ? null : selectedSessionId}
    >
      <WorkbenchIslandProvider>
        <div
          className="workbench-shell"
          data-chrome-mode={chromeMode}
          data-has-project={!!effectiveProjectId}
          data-active-panel={activePanel ?? undefined}
        >
          <WorkbenchHeader
            chromeMode={chromeMode}
            activePanel={activePanel}
            onPanelToggle={handlePanelToggle}
            hasProject={!!effectiveProjectId}
            projectName={projectName}
            currentProjectId={effectiveProjectId}
            projects={projects}
            onProjectSwitch={(id) => navigate(resolveSessionsEntryPath(id))}
            onCreateProject={() => setCreateDialogOpen(true)}
            onRemoveProject={handleRemoveProject}
          />
          <div className="workbench-island">
            <div className="island-body">
              {/* Sessions are never retained across page switches. */}
              {effectiveProjectId && <>
                {activePanel === "sessions" && (
                  <Suspense fallback={<PageLoading />}>
                    <SessionsPage />
                  </Suspense>
                )}
              </>}
              {/* Outlet for non-cached routes (welcome, settings) */}
              <div
                className={
                  isCachedPanel ? "hidden" : "flex-1 min-h-0 flex flex-col"
                }
              >
                <Outlet
                  context={{ onCreateProject: () => setCreateDialogOpen(true), onRemoveProject: handleRemoveProject }}
                />
              </div>
            </div>
          </div>
          <TerminalDrawer
            projectId={effectiveProjectId}
            sessionId={selectedSessionId}
          />
          <ProjectCreateDialog
            open={createDialogOpen}
            onClose={() => setCreateDialogOpen(false)}
          />
          <ToastContainer />
        </div>
      </WorkbenchIslandProvider>
    </SessionEnvironmentProvider>
  );
}
