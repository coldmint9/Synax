import { useEffect } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { Plus, FolderCode } from "lucide-react";
import { IconSurface } from "../../shared/ui/IconSurface";
import { useShellStore } from "../../shared/state/shellStore";
import { useLocale } from "../../shared/hooks/useLocale";
import { resolveSessionsEntryPath } from "../../features/agent-workspace/sessionLastVisit";
import { resolveStartupWorkspaceId } from "../../features/workspace/lastOpenedWorkspace";

interface WorkbenchContext {
  onCreateProject: () => void;
}

export function WelcomeView() {
  const { onCreateProject } = useOutletContext<WorkbenchContext>();
  const { t } = useLocale();
  const projects = useShellStore((s) => s.projects);
  const projectsLoaded = useShellStore((s) => s.projectsLoaded);
  const defaultHome = useShellStore((s) => s.preferences.defaultHome);
  const fetchProjects = useShellStore((s) => s.ensureProjects);
  const navigate = useNavigate();

  useEffect(() => {
    if (!projectsLoaded) void fetchProjects();
  }, [projectsLoaded, fetchProjects]);

  useEffect(() => {
    if (!projectsLoaded) return;
    if (defaultHome === "global-home") return;
    // Restore the workspace that was open when the app closed. Project
    // `updatedAt` cannot answer that question: a session run elsewhere bumps it
    // while the workspace the user actually left is unchanged.
    const workspaceId = resolveStartupWorkspaceId(projects);
    if (!workspaceId) return;
    navigate(resolveSessionsEntryPath(workspaceId), { replace: true });
  }, [projectsLoaded, projects, defaultHome, navigate]);

  if (!projectsLoaded) return null;

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <IconSurface tone="muted" size="xl" className="mx-auto rounded-2xl">
          <FolderCode size={24} />
        </IconSurface>
        <p className="mt-4 text-sm font-medium text-foreground">
          {t("welcomeImportHint")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("welcomeConnectHint")}
        </p>
        <button
          type="button"
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
          onClick={onCreateProject}
        >
          <Plus size={13} />
          {t("appImportProject")}
        </button>
      </div>
    </div>
  );
}
