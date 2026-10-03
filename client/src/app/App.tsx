import { PageLoading } from "./layouts/CachedWorkbenchPage";
import { GlobalSessionSearch } from "../features/agent-workspace/GlobalSessionSearch";
import { Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense, useEffect } from "react";
import WorkbenchLayout from "./layouts/WorkbenchLayout";
import { WelcomeView } from "./layouts/WelcomeView";
const AgentLoopTestPage = lazy(() => import("./pages/AgentLoopTestPage"));
const GitWorkbenchPage = lazy(() => import("../features/git/GitWorkbenchPage"));
const AboutPage = lazy(() => import("./pages/AboutPage"));
const GlobalSettingsPage = lazy(() => import("../features/settings/GlobalSettingsPage"));
const ProjectSettingsPage = lazy(() => import("../features/settings/ProjectSettingsPage"));
import { useElectronMenu } from "../adapters/electron/electron-menu";
import { useTabKeyBehavior } from "../shared/hooks/useTabKeyBehavior";
import { WorkspaceFileMutationHost } from "../features/agent-workspace/WorkspaceFileMutationHost";
import { ContextMenuProvider } from "../shared/ui/context-menu/ContextMenuProvider";
import { DesktopUpdateProvider } from "../features/updates/DesktopUpdateProvider";
import { DesktopUpdatePanel } from "../features/updates/DesktopUpdateStatus";
import { configApi } from "../adapters/transport/config";
import { applyMacWindowAppearance, DEFAULT_MAC_WINDOW_APPEARANCE } from "../adapters/electron/mac-window-appearance";
import "../features/settings/components/appearance.css";

export default function App() {
  useTabKeyBehavior();

  useEffect(() => {
    let cancelled = false;
    if (navigator.userAgent.includes("Electron")) {
      document.documentElement.classList.add("electron");
      (window as any).electronAPI?.reportUIReady?.();
      if ((window as any).electronAPI?.platform === "darwin") {
        document.documentElement.classList.add("electron-macos");
        void configApi.getGlobal().then(({ config }) => {
          if (cancelled) return;
          return applyMacWindowAppearance(config.macWindowAppearance ?? DEFAULT_MAC_WINDOW_APPEARANCE);
        }).catch(() => undefined);
      } else if ((window as any).electronAPI?.platform === "win32") {
        document.documentElement.classList.add("electron-windows");
      }
    }
    return () => { cancelled = true; };
  }, []);

  useElectronMenu();

  return (
    <ContextMenuProvider>
    <WorkspaceFileMutationHost />
    <DesktopUpdateProvider>
      <GlobalSessionSearch />
      <DesktopUpdatePanel />
      <div className="app-viewport flex flex-col overflow-hidden bg-background text-foreground">
        <div className="min-h-0 flex-1">
          <Routes>
            <Route element={<WorkbenchLayout />}>
              <Route path="/" element={<WelcomeView />} />
              <Route path="/settings" element={<Suspense fallback={<PageLoading />}><GlobalSettingsPage /></Suspense>} />
              <Route path="/about" element={<Suspense fallback={<PageLoading />}><AboutPage /></Suspense>} />
              <Route
                path="/projects/:projectId"
                element={<Navigate to="sessions" replace />}
              />
              <Route
                path="/projects/:projectId/git"
                element={<Suspense fallback={<PageLoading />}><GitWorkbenchPage /></Suspense>}
              />
              <Route
                path="/projects/:projectId/git/mr/:mrId"
                element={<Suspense fallback={<PageLoading />}><GitWorkbenchPage /></Suspense>}
              />
              {/* sessions 由 WorkbenchLayout keep-alive 块渲染，路由仅用于 URL 匹配 */}
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
                element={<Suspense fallback={<PageLoading />}><ProjectSettingsPage /></Suspense>}
              />
            </Route>
            <Route path="/agent-loop-test" element={<Suspense fallback={<PageLoading />}><AgentLoopTestPage /></Suspense>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </DesktopUpdateProvider>
    </ContextMenuProvider>
  );
}
