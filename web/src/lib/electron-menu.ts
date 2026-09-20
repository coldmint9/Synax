import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useShellStore } from "../react/state/shellStore";
import { useAgentSessionStore } from "../react/features/agent-workspace/state/agentSessionStore";
import {
  useSessionWorkspace,
  useSessionWorkspaceStore,
} from "../react/features/agent-workspace/state/sessionWorkspaceStore";
import { resolveSessionsEntryPath } from "../react/features/agent-workspace/sessionLastVisit";
import { newSessionPath } from "../react/features/agent-workspace/sessionRoutes";
import { refreshWorkspace } from "../react/features/agent-workspace/workspaceRefresh";

const api = (window as any).electronAPI;

export function useElectronMenu() {
  const navigate = useNavigate();
  const location = useLocation();
  const projects = useShellStore((s) => s.projects);
  const currentProjectId = useShellStore((s) => s.currentProjectId);
  const theme = useShellStore((s) => s.resolvedTheme);
  const selectedSessionId = useAgentSessionStore((s) => s.selectedSessionId);
  const workspace = useSessionWorkspace(selectedSessionId);
  const projectId =
    location.pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? currentProjectId;
  const inWork = location.pathname.includes("/sessions");
  const inWiki = location.pathname.includes("/wiki");

  useEffect(() => {
    if (!api) return;
    const offNavigate = api.onMenuNavigate((path: string) => navigate(path));
    const offAction = api.onMenuAction((action: string) => {
      const sessionId = useAgentSessionStore.getState().selectedSessionId;
      switch (action) {
        case "terminal:new":
        case "terminal:toggle":
          document.dispatchEvent(new CustomEvent(action));
          break;
        case "project:import":
          document.dispatchEvent(new CustomEvent("menu:import-project"));
          break;
        case "session:new":
          if (projectId) navigate(newSessionPath(projectId));
          break;
        case "view:wiki":
          if (projectId) navigate(`/projects/${projectId}/wiki`);
          break;
        case "view:conversation":
        case "view:sessions":
          if (sessionId)
            useSessionWorkspaceStore.getState().showDashboard(sessionId);
          if (projectId) navigate(resolveSessionsEntryPath(projectId));
          break;
        case "toggle:sidebar":
          document.dispatchEvent(new CustomEvent("menu:toggle-sidebar"));
          break;
        case "workspace:refresh":
          if (sessionId) refreshWorkspace(sessionId);
          break;
        case "theme:toggle": {
          const shell = useShellStore.getState();
          shell.setTheme(shell.resolvedTheme === "dark" ? "light" : "dark");
          break;
        }
      }
    });
    return () => {
      offNavigate?.();
      offAction?.();
    };
  }, [navigate, projectId]);

  useEffect(() => {
    api?.updateProjects(projects.map((p) => ({ id: p.id, name: p.name })));
  }, [projects]);
  useEffect(() => {
    api?.updateMenuState?.({
      projectId,
      hasSession: Boolean(selectedSessionId),
      hasViewer: inWork && Boolean(workspace.activeTabId),
      inWork,
      inWiki,
      dark: theme === "dark",
    });
  }, [
    projectId,
    selectedSessionId,
    workspace.activeTabId,
    inWork,
    inWiki,
    theme,
  ]);
}
