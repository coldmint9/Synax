import { ToolbarPill } from "./ToolbarPill";
import { GitToolbarTarget } from "../../features/git/GitToolbarPortal";
import { useLocation } from "react-router-dom";
import { Terminal as TerminalIcon } from "lucide-react";
import { IslandSurface } from "./IslandSurface";
import { ThemeToggle } from "../../shared/ui/ThemeToggle";
import { useTerminalStore } from "../../features/terminal/terminalStore";
import { useState, useCallback, useEffect } from "react";
import { WorkspaceSwitcher } from "../../features/workspace/WorkspaceSwitcher";
import { WorkspaceRemoveDialog } from "../../features/workspace/WorkspaceRemoveDialog";
import { Popover, PopoverButton } from "@/shared/ui/ui/Popover";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
import { IslandPopoverPanel } from "./IslandOverlays";
import { IslandSelection } from "./IslandSelection";
import { Button } from "@/shared/ui/ui/Button";
import {
  GitMerge,
  Bot,
  Settings2,
  ChevronDown,
  Target,
} from "lucide-react";
import { useShellStore, type ProjectSummary } from "../../shared/state/shellStore";
import { useLocale } from "../../shared/hooks/useLocale";
import { useAgentSessionStore } from "../../features/agent-workspace/state/agentSessionStore";
import {
  useProjectSessionBadges,
  type ProjectSessionBadge,
} from "../../features/agent-workspace/projectSessionBadges";
import { useSessionWorkspaceStore } from "../../features/agent-workspace/state/sessionWorkspaceStore";
import { GoalMonitorPanel } from "../../features/agent-workspace/GoalMonitorPanel";
import { ProjectImportHint } from "./ProjectImportHint";
import { WorkbenchIsland } from "./WorkbenchIsland";
import { SubagentIsland } from "../../features/agent-workspace/SubagentIsland";
import type { ActivityPanel } from "./ActivityBar";

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

const navTabs: { id: ActivityPanel; icon: typeof Bot; label: string }[] = [
  { id: "sessions", icon: Bot, label: "Work" },
  { id: "git", icon: GitMerge, label: "Git" },
];

function ProjectSessionBadgeMark({
  badge,
  showCount = false,
  className,
}: {
  badge?: ProjectSessionBadge;
  showCount?: boolean;
  className?: string;
}) {
  const { t } = useLocale();
  if (!badge?.total) return null;

  const label = [
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
      className={["project-session-badge", className].filter(Boolean).join(" ")}
      title={label}
      aria-label={label}
    >
      <span
        className="project-session-badge__dot"
        data-status={badge.running > 0 ? "running" : "unread"}
        aria-hidden="true"
      />
      {showCount && badge.running > 0 && (
        <span className="project-session-badge__count" aria-hidden="true">
          {badge.running}
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
  iconOnly = false,
}: {
  hasProject: boolean;
  projectName: string;
  currentProjectId: string;
  projects: ProjectSummary[];
  onProjectSwitch: (projectId: string) => void;
  onCreateProject: () => void;
  onRemoveRequest: (event: React.MouseEvent, project: ProjectSummary) => void;
  onOpen?: () => void;
  iconOnly?: boolean;
}) {
  const { badges, refresh } = useProjectSessionBadges(projects.map(project => project.id));
  return <WorkspaceSwitcher
    hasProject={hasProject} projectName={projectName} currentProjectId={currentProjectId}
    projects={projects} onProjectSwitch={onProjectSwitch} onCreateProject={onCreateProject}
    onRemoveRequest={onRemoveRequest} iconOnly={iconOnly}
    onOpen={() => { onOpen?.(); void refresh(); }}
    badge={<ProjectSessionBadgeMark badge={badges[currentProjectId]} className={iconOnly ? "project-session-badge--icon-trigger" : undefined} />}
    renderBadge={id => <ProjectSessionBadgeMark badge={badges[id]} showCount />}
  />;
}

function MainNavTabs({
  activePanel,
  hasProject,
  onPanelToggle,
  iconOnly = false,
}: {
  activePanel: ActivityPanel | null;
  hasProject: boolean;
  onPanelToggle: (panel: ActivityPanel) => void;
  iconOnly?: boolean;
}) {
  const { t } = useLocale();

  return (
    <nav
      aria-label={t("workspaceMainNav")}
      className={`wh-tabs ${iconOnly ? "wh-tabs--icon-only" : ""}`}
    >
      <IslandSelection activeKey={activePanel} className="wh-tabs-list">
        {navTabs
          .map((tab) => {
            const Icon = tab.icon;
            return (
              <Button
                key={tab.id}
                data-island-option={tab.id}
                variant="ghost"
                size="sm"
                disabled={!hasProject}
                aria-pressed={activePanel === tab.id}
                onClick={() => onPanelToggle(tab.id)}
                aria-label={tab.label}
                className={`wh-tab wh-tab--${tab.id} ${activePanel === tab.id ? "bg-primary/10 text-primary" : ""}`}
              >
                <Icon size={13} />
                {!iconOnly && <span>{tab.label}</span>}
              </Button>
            );
          })}
      </IslandSelection>
    </nav>
  );
}

function GoalToolbarPill({
  sessionId,
  visible,
  iconOnly = false,
}: {
  sessionId: string | null;
  visible: boolean;
  iconOnly?: boolean;
}) {
  const { locale } = useLocale();
  const label = locale === "zh" ? "目标" : "Goal";
  return (
    <ToolbarPill visible={visible && Boolean(sessionId)}>
      {sessionId && (
        <Popover>
          {({ open }) => <>
          <Tooltip content={label}><PopoverButton className={`wh-goal-menu ${iconOnly ? "wh-goal-menu--icon" : ""}`} aria-label={label}>
            <Target size={14} />{!iconOnly && <span>{label}</span>}<ChevronDown size={11} aria-hidden="true" />
          </PopoverButton></Tooltip>
          <IslandPopoverPanel open={open} focus className="goal-monitor-menu" aria-label={label}>
            <GoalMonitorPanel sessionId={sessionId} />
          </IslandPopoverPanel>
          </>}
        </Popover>
      )}
    </ToolbarPill>
  );
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
  const { t } = useLocale();
  const location = useLocation();
  const terminalOpen = useTerminalStore((state) => state.open);
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

  const placement =
    chromeMode === "workspaceDock" || chromeMode === "workspaceFocus"
      ? "viewer"
      : activePanel === "sessions"
        ? "conversation"
        : "global";

  return (
    <WorkbenchIsland placement={placement}>
      {(compact) => (
        <div
          className={`workbench-header${compact ? " workbench-header--docked" : ""}`}
        >
          <>
            <IslandSurface kind="primary">
                <div className="project-switcher-anchor">
                  <ProjectSwitcher
                    hasProject={hasProject}
                    projectName={projectName}
                    currentProjectId={currentProjectId}
                    projects={projects}
                    onProjectSwitch={onProjectSwitch}
                    onCreateProject={onCreateProject}
                    onRemoveRequest={handleRemoveClick}
                    onOpen={() => setProjectSwitcherUsed(true)}
                    iconOnly={compact}
                  />

                  <ProjectImportHint
                    hasProject={hasProject}
                    targetActivated={projectSwitcherUsed}
                    onImport={onCreateProject}
                  />
                </div>

                <div className="wh-divider" />

                <MainNavTabs
                  activePanel={activePanel}
                  hasProject={hasProject}
                  onPanelToggle={onPanelToggle}
                  iconOnly={compact}
                />

                <div className="wh-divider" />

                <div className="wh-actions">
                  <Tooltip content={useShellStore.getState().preferences.locale === "zh" ? "终端" : "Terminal"}><button
                    type="button"
                    className={`wh-btn ${terminalOpen ? "active" : ""}`}
                    aria-pressed={terminalOpen}
                    aria-label={
                      useShellStore.getState().preferences.locale === "zh"
                        ? "终端"
                        : "Terminal"
                    }
                    onClick={() => useTerminalStore.getState().toggle()}
                  >
                    <TerminalIcon size={15} />
                  </button></Tooltip>
                  <Tooltip content={t("appSettings")}><button
                    type="button"
                    className={`wh-btn ${activePanel === "settings" ? "active" : ""}`}
                    aria-pressed={activePanel === "settings"}
                    aria-label={t("appSettings")}
                    onClick={() => onPanelToggle("settings")}
                  >
                    <Settings2 size={15} />
                  </button></Tooltip>
                  <ThemeToggle />
                </div>
            </IslandSurface>

            {activePanel === "sessions" && selectedSessionId && chromeMode !== "global" ? (
              <SubagentIsland sessionId={selectedSessionId} />
            ) : null}

            <GoalToolbarPill
              sessionId={goalSessionId}
              visible={hasProject && Boolean(goalSessionId)}
              iconOnly={compact}
            />
            <ToolbarPill visible={gitToolbarVisible}>
              <GitToolbarTarget />
            </ToolbarPill>
          </>

          <WorkspaceRemoveDialog workspace={deleteTarget} currentProjectId={currentProjectId} onRemove={onRemoveProject} onClose={() => setDeleteTarget(null)} />
        </div>
      )}
    </WorkbenchIsland>
  );
}
