import { GlobalSessionSearch } from "./features/agent-workspace/GlobalSessionSearch";
import { Navigate, Route, Routes } from "react-router-dom";
import { useEffect } from "react";
import WorkbenchLayout from "./layouts/WorkbenchLayout";
import { WelcomeView } from "./layouts/WelcomeView";
import AgentLoopTestPage from "./pages/AgentLoopTestPage";
import GitWorkbenchPage from "./features/git/GitWorkbenchPage";
import AboutPage from "./pages/AboutPage";
import GlobalSettingsPage from "./features/settings/GlobalSettingsPage";
import ProjectSettingsPage from "./features/settings/ProjectSettingsPage";
import { useElectronMenu } from "../lib/electron-menu";
import { useWikiStore } from "./state/wikiStore";
import { useTabKeyBehavior } from "../hooks/useTabKeyBehavior";
import { ContextMenuProvider } from "./components/context-menu/ContextMenuProvider";
import { DesktopUpdateProvider } from "./features/updates/DesktopUpdateProvider";
import { DesktopUpdatePanel } from "./features/updates/DesktopUpdateStatus";

export default function App() {
  useTabKeyBehavior();

  useEffect(() => {
    if (navigator.userAgent.includes("Electron")) {
      document.documentElement.classList.add("electron");
      (window as any).electronAPI?.reportUIReady?.();
      if ((window as any).electronAPI?.platform === "darwin") {
        document.documentElement.classList.add("electron-macos");
      } else if ((window as any).electronAPI?.platform === "win32") {
        document.documentElement.classList.add("electron-windows");
      }
    }
  }, []);

  useElectronMenu();

  const draftPreviewActive = useWikiStore((s) => s.draftPreviewActive);

  return (
    <ContextMenuProvider>
    <DesktopUpdateProvider>
      <GlobalSessionSearch />
      <DesktopUpdatePanel />
      <div className="app-viewport flex flex-col overflow-hidden bg-background text-foreground">
        <div className="min-h-0 flex-1">
          <Routes>
            <Route element={<WorkbenchLayout />}>
              <Route path="/" element={<WelcomeView />} />
              <Route path="/settings" element={<GlobalSettingsPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route
                path="/projects/:projectId"
                element={<Navigate to="sessions" replace />}
              />
              <Route
                path="/projects/:projectId/git"
                element={<GitWorkbenchPage />}
              />
              <Route
                path="/projects/:projectId/git/mr/:mrId"
                element={<GitWorkbenchPage />}
              />
              {/* wiki/sessions 由 WorkbenchLayout keep-alive 块渲染，路由仅用于 URL 匹配 */}
              <Route path="/projects/:projectId/wiki" element={null} />
              <Route path="/projects/:projectId/sessions" element={null} />
              <Route path="/projects/:projectId/sessions/new" element={null} />
              <Route
                path="/projects/:projectId/sessions/workflows"
                element={null}
              />
              <Route
                path="/projects/:projectId/sessions/skills"
                element={null}
              />
              <Route
                path="/projects/:projectId/sessions/sources"
                element={null}
              />
              <Route
                path="/projects/:projectId/settings"
                element={<ProjectSettingsPage />}
              />
            </Route>
            <Route path="/agent-loop-test" element={<AgentLoopTestPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
        {/* Draft preview mode glow overlay */}
        <div
          className={`pointer-events-none fixed inset-0 z-[9999] will-change-[opacity] transition-opacity duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
            draftPreviewActive ? "opacity-100" : "opacity-0"
          }`}
          style={{
            boxShadow:
              "inset 0 0 40px 8px color-mix(in srgb, var(--warning) 25%, transparent), inset 0 0 12px 2px color-mix(in srgb, var(--warning) 40%, transparent)",
          }}
          aria-hidden="true"
        />
      </div>
    </DesktopUpdateProvider>
    </ContextMenuProvider>
  );
}
