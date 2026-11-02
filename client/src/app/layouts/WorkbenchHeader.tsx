import { GitToolbarTarget } from "../../features/git/GitToolbarPortal";
import { useLocation } from "react-router-dom";
import { useState, useCallback, useEffect } from "react";
import { WorkspaceSwitcher } from "../../features/workspace/WorkspaceSwitcher";
import { WorkspaceRemoveDialog } from "../../features/workspace/WorkspaceRemoveDialog";
import { SessionToolbarTarget, SessionToolbarActionsTarget } from "../../features/agent-workspace/SessionToolbarPortal";
import type { ProjectSummary } from "../../shared/state/shellStore";
import { useLocale } from "../../shared/hooks/useLocale";
import { useAgentSessionStore } from "../../features/agent-workspace/state/agentSessionStore";
import {
  projectSessionActivity,
  useProjectSessionBadges,
  type ProjectSessionBadge,
} from "../../features/agent-workspace/projectSessionBadges";
import { useWorkspaceCopy } from "../../features/workspace/workspaceCopy";
import { useSessionWorkspaceStore } from "../../features/agent-workspace/state/sessionWorkspaceStore";
import { ProjectImportHint } from "./ProjectImportHint";
import { SubagentIsland } from "../../features/agent-workspace/SubagentIsland";
import type { ActivityPanel } from "./ActivityBar";
import { useMacWindowButtons } from "../../adapters/electron/useMacWindowButtons";
import { WindowChrome } from "./WindowChrome";
import { WorkbenchNav } from "./toolbar/WorkbenchNav";
import { WorkbenchActions } from "./toolbar/WorkbenchActions";
import { BackendConnectionStatus } from "./toolbar/BackendConnectionStatus";
import { GoalToolbar } from "./toolbar/GoalToolbar";

export type ChromeMode =
  | "global"
  | "agentDock"
  | "workspaceDock"
  | "workspaceFocus";

interface WorkbenchHeaderProps {
  chromeMode: ChromeMode;
  activePanel: ActivityPanel | null;
  onPanelToggle: (panel: ActivityPanel) => void;
  hasProject: boolean;
  projectName: string;
  currentProjectId: string;
  projects: ProjectSummary[];
  onProjectSwitch: (projectId: string) => void;
  onCreateProject: () => void;
  onRemoveProject: (projectId: string) => Promise<void>;
}

function ProjectSessionBadgeMark({
  badge,
  showCount = false,
}: {
  badge?: ProjectSessionBadge;
  showCount?: boolean;
}) {
  const { t } = useLocale();
  const c = useWorkspaceCopy();
  const activity = projectSessionActivity(badge);
  if (!badge || !activity) return null;

  const label = [
    badge.waitingInput > 0 ? c.activityWaiting.replace("{count}", String(badge.waitingInput)) : "",
    badge.unreadFailed > 0 ? c.activityFailed.replace("{count}", String(badge.unreadFailed)) : "",
    badge.running > 0 ? t("projectBadgeRunning", { count: badge.running }) : "",
    badge.unreadCompleted > 0
      ? t("projectBadgeUnread", { count: badge.unreadCompleted })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      role="img"
      className="project-session-badge"
      title={label}
      aria-label={label}
    >
      <span
        className="project-session-badge__dot"
        data-status={activity.status}
        aria-hidden="true"
      />
      {showCount && (
        <span className="project-session-badge__count" aria-hidden="true">
          {activity.count}
        </span>
      )}
    </span>
  );
}

function ProjectSwitcher({
  hasProject,
  projectName,
  currentProjectId,
  projects,
  onProjectSwitch,
  onCreateProject,
  onRemoveRequest,
  onOpen,
}: {
  hasProject: boolean;
  projectName: string;
  currentProjectId: string;
  projects: ProjectSummary[];
  onProjectSwitch: (projectId: string) => void;
  onCreateProject: () => void;
  onRemoveRequest: (event: React.MouseEvent, project: ProjectSummary) => void;
  onOpen?: () => void;
}) {
  const { badges, refresh } = useProjectSessionBadges(projects.map(project => project.id), currentProjectId);
  const otherBadges = projects.reduce<ProjectSessionBadge>(
    (counts, project) => {
      const badge = badges[project.id];
      if (project.id !== currentProjectId && badge) {
        counts.waitingInput += badge.waitingInput;
        counts.unreadFailed += badge.unreadFailed;
        counts.running += badge.running;
        counts.unreadCompleted += badge.unreadCompleted;
        counts.total += badge.total;
      }
      return counts;
    },
    { waitingInput: 0, unreadFailed: 0, running: 0, unreadCompleted: 0, total: 0 },
  );
  return <WorkspaceSwitcher
    hasProject={hasProject} projectName={projectName} currentProjectId={currentProjectId}
    projects={projects} onProjectSwitch={onProjectSwitch} onCreateProject={onCreateProject}
    onRemoveRequest={onRemoveRequest}
    otherActivity={projectSessionActivity(otherBadges)}
    onOpen={() => { onOpen?.(); void refresh(); }}
    renderBadge={id => id === currentProjectId ? null : <ProjectSessionBadgeMark badge={badges[id]} showCount />}
  />;
}

export function WorkbenchHeader({
  chromeMode,
  activePanel,
  onPanelToggle,
  hasProject,
  projectName,
  currentProjectId,
  projects,
  onProjectSwitch,
  onCreateProject,
  onRemoveProject,
}: WorkbenchHeaderProps) {
  const leadingRef = useMacWindowButtons();
  const { locale } = useLocale();
  const location = useLocation();
  const gitToolbarVisible =
    activePanel === "git" && !location.pathname.includes("/git/mr/");
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [projectSwitcherUsed, setProjectSwitcherUsed] = useState(false);
  const handleRemoveClick = useCallback((event: React.MouseEvent, project: ProjectSummary) => {
    event.stopPropagation();
    setDeleteTarget(project);
  }, []);

  const selectedSessionId = useAgentSessionStore((s) => s.selectedSessionId);
  const goalSessionId = useAgentSessionStore((s) => {
    const current = s.sessions.find(
      (session) => session.id === s.selectedSessionId,
    );
    return current?.sessionMetadata?.mode === "goal" &&
      current.sessionMetadata.goal
      ? current.id
      : null;
  });
  useEffect(() => {
    if (chromeMode !== "workspaceFocus" || !selectedSessionId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"]',
        )
      )
        return;
      if (document.querySelector('[role="dialog"]')) return;
      useSessionWorkspaceStore.getState().exitFocus(selectedSessionId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chromeMode, selectedSessionId]);

  return (
    <header className="workbench-header" aria-label={locale === "zh" ? "工作区工具栏" : "Workspace toolbar"}>
      <div className="workbench-header__bar">
        <div className="workbench-header__leading" ref={leadingRef}>
          <div className="project-switcher-anchor workbench-header__workspace">
            <ProjectSwitcher
              hasProject={hasProject}
              projectName={projectName}
              currentProjectId={currentProjectId}
              projects={projects}
              onProjectSwitch={onProjectSwitch}
              onCreateProject={onCreateProject}
              onRemoveRequest={handleRemoveClick}
              onOpen={() => setProjectSwitcherUsed(true)}
            />
            <ProjectImportHint hasProject={hasProject} targetActivated={projectSwitcherUsed} onImport={onCreateProject} />
          </div>
          {activePanel === "sessions" && hasProject ? <SessionToolbarTarget /> : null}
        </div>
        <div className="workbench-header__navigation">
          <WorkbenchNav
            activePanel={activePanel}
            hasProject={hasProject}
            projectId={hasProject ? currentProjectId : null}
            sessionId={selectedSessionId}
            onPanelToggle={onPanelToggle}
          />
          {gitToolbarVisible && <div className="workbench-header__git-tools"><GitToolbarTarget /></div>}
        </div>
        <div className="wh-actions workbench-header__actions">
          <BackendConnectionStatus />
          {activePanel === "sessions" && selectedSessionId && chromeMode !== "global" ? (
            <SubagentIsland sessionId={selectedSessionId} />
          ) : null}
          <GoalToolbar sessionId={hasProject ? goalSessionId : null} />
          <WorkbenchActions activePanel={activePanel} onPanelToggle={onPanelToggle} />
          {activePanel === "sessions" && hasProject ? <SessionToolbarActionsTarget /> : null}
        </div>
        <WindowChrome />
      </div>
      <WorkspaceRemoveDialog workspace={deleteTarget} currentProjectId={currentProjectId}
        onRemove={onRemoveProject} onClose={() => setDeleteTarget(null)} />
    </header>
  );
}
