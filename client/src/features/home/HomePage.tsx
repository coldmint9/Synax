import { useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { FolderPlus } from "lucide-react";
import { useShellStore } from "../../shared/state/shellStore";
import { useLocale } from "../../shared/hooks/useLocale";
import { Button } from "../../shared/ui/ui/Button";
import { SessionComposer } from "../agent-workspace/SessionComposer";
import { NewSessionScene } from "../agent-workspace/NewSessionScene";
import { resolveStartupWorkspaceId } from "../workspace/lastOpenedWorkspace";
import { HomeFeaturePanel } from "./HomeFeaturePanel";

/** Root entry uses the same feature area and composer as Work's new-session view. */
export default function HomePage() {
  const { onCreateProject } = useOutletContext<{ onCreateProject: () => void }>();
  const { locale } = useLocale();
  const projects = useShellStore((state) => state.projects);
  const loaded = useShellStore((state) => state.projectsLoaded);
  const currentId = useShellStore((state) => state.currentProjectId);
  const setCurrentId = useShellStore((state) => state.setCurrentProjectId);
  const projectId = projects.some((project) => project.id === currentId)
    ? currentId
    : resolveStartupWorkspaceId(projects);

  useEffect(() => {
    if (loaded && projectId && projectId !== currentId) setCurrentId(projectId);
  }, [loaded, projectId, currentId, setCurrentId]);

  return <main className="home-page">
    {loaded && projectId ? <SessionComposer key={projectId} projectId={projectId} layout="centered" /> : (
      <div className="home-page__empty">
        <NewSessionScene home>
          <HomeFeaturePanel locale={locale} />
          <div className="home-page__setup" data-welcome-enter="">
            <p role="status">{!loaded
              ? locale === "zh" ? "正在加载工作区…" : "Loading workspaces…"
              : locale === "zh" ? "尚未添加工作区" : "No workspaces yet"}</p>
            <Button size="sm" onClick={onCreateProject} disabled={!loaded}><FolderPlus size={14} />{locale === "zh" ? "导入工作区" : "Import workspace"}</Button>
          </div>
        </NewSessionScene>
      </div>
    )}
  </main>;
}
