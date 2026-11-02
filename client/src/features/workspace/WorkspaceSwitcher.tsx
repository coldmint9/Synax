import { useId, useState, type MouseEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Check,
  ChevronDown,
  Ellipsis,
  Folder,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { Popover, PopoverButton, PopoverPanel } from "@/shared/ui/ui/Popover";
import {
  Menu,
  MenuAction,
  MenuButton,
  MenuItems,
  MenuOpenObserver,
} from "@/shared/ui/ui/Menu";
import { Button } from "@/shared/ui/ui/Button";
import { Input } from "@/shared/ui/ui/Field";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
import type { ProjectSummary } from "../../shared/state/shellStore";
import type { ProjectSessionActivity } from "../agent-workspace/projectSessionBadges";
import { useLocale } from "../../shared/hooks/useLocale";
import { useWorkspaceCopy } from "./workspaceCopy";
import { WorkspaceRenameDialog } from "./WorkspaceRenameDialog";
import "./workspaceControls.css";

interface Props {
  hasProject: boolean;
  projectName: string;
  currentProjectId: string;
  projects: ProjectSummary[];
  onProjectSwitch: (id: string) => void;
  onCreateProject: () => void;
  onRemoveRequest: (event: MouseEvent, project: ProjectSummary) => void;
  onOpen?: () => void;
  iconOnly?: boolean;
  otherActivity?: ProjectSessionActivity;
  renderBadge: (id: string) => ReactNode;
}

export function WorkspaceSwitcher({
  hasProject,
  projectName,
  currentProjectId,
  projects,
  onProjectSwitch,
  onCreateProject,
  onRemoveRequest,
  onOpen,
  iconOnly,
  otherActivity,
  renderBadge,
}: Props) {
  const c = useWorkspaceCopy();
  const { t } = useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState("");
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);
  const [notice, setNotice] = useState("");
  const activityDescriptionId = useId();
  const filtered = projects.filter((project) =>
    project.name
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  const displayName = hasProject ? projectName : c.switchWorkspace;
  const activityLabels = {
    waiting: c.waitingElsewhere,
    failed: c.failedElsewhere,
    running: c.runningElsewhere,
    unread: c.unreadElsewhere,
  };
  const activityDescription = otherActivity
    ? activityLabels[otherActivity.status].replace("{count}", String(otherActivity.count))
    : c.noActivityElsewhere;
  /** Management is a route, so the popover closes before navigating. */
  const openManagement = (project: ProjectSummary) => {
    navigate(`/workspaces/${encodeURIComponent(project.id)}/manage`, {
      state: {
        workspaceReturnTo: location.pathname + location.search,
      },
    });
  };
  if (projects.length === 0) {
    return (
      <Tooltip content={c.title}>
        <button
          type="button"
          className={`wh-project-trigger ${iconOnly ? "wh-project-trigger--icon" : ""}`}
          aria-label={c.title}
          onClick={() => {
            onOpen?.();
            onCreateProject();
          }}
        >
          <Plus size={15} aria-hidden="true" />
          {!iconOnly && <span className="wh-project-label">{c.title}</span>}
        </button>
      </Tooltip>
    );
  }
  return (
    <>
      <Popover>
        {({ open, close }) => (
          <>
            <MenuOpenObserver
              open={open}
              onOpen={() => {
                setSearch("");
                onOpen?.();
              }}
            />
            <Tooltip
              content={otherActivity ? `${displayName} · ${activityDescription}` : displayName}
            >
              <PopoverButton
                className={`wh-project-trigger ${iconOnly ? "wh-project-trigger--icon" : ""}`}
                aria-label={t("appSwitchProject")}
                aria-describedby={otherActivity ? activityDescriptionId : undefined}
              >
                <Folder size={15} aria-hidden="true" />
                {!iconOnly && (
                  <span className="wh-project-label">{displayName}</span>
                )}
                {otherActivity && (
                  <span className="workspace-activity" data-status={otherActivity.status} aria-hidden="true">
                    <span className="workspace-activity__signal">
                      <span />
                      <span />
                      <span />
                    </span>
                    <span className="workspace-activity__count">{otherActivity.count}</span>
                  </span>
                )}
                {!iconOnly && <ChevronDown size={12} aria-hidden="true" />}
              </PopoverButton>
            </Tooltip>
            <PopoverPanel
              anchor={{ to: "bottom start", gap: 8, padding: 8 }}
              className="workspace-switcher"
              aria-label={c.switchWorkspace}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                  return;
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                );
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                if (!buttons.length) return;
                event.preventDefault();
                const next =
                  index < 0
                    ? event.key === "ArrowDown"
                      ? 0
                      : buttons.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        buttons.length) %
                      buttons.length;
                buttons[next]?.focus();
              }}
            >
              <div className="workspace-switcher-heading">{c.workspaces}</div>
              <div className="workspace-switcher-search">
                <Search size={14} aria-hidden="true" />
                <Input
                  autoFocus
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label={c.searchWorkspaces}
                  placeholder={c.searchWorkspaces}
                />
              </div>
              <div
                className="workspace-switcher-list"
                role="group"
                aria-label={c.workspaces}
              >
                {filtered.map((project) => (
                  <div
                    key={project.id}
                    className="workspace-switcher-row"
                    data-current={project.id === currentProjectId || undefined}
                  >
                    <Button
                      variant="ghost"
                      className="workspace-switcher-action"
                      aria-current={
                        project.id === currentProjectId ? "true" : undefined
                      }
                      onClick={() => {
                        close();
                        onProjectSwitch(project.id);
                      }}
                    >
                      <Folder size={16} aria-hidden="true" />
                      <span className="workspace-switcher-name" title={project.name}>
                        {project.name}
                      </span>
                      {renderBadge(project.id)}
                      {project.id === currentProjectId && (
                        <Check size={14} aria-label={c.currentWorkspace} />
                      )}
                    </Button>
                    <Menu>
                      <MenuButton
                        className="workspace-switcher-more"
                        aria-label={`${c.workspaceMore}: ${project.name}`}
                      >
                        <Ellipsis size={16} aria-hidden="true" />
                      </MenuButton>
                      {/* The row menu lives inside the already-open switcher; making it
                          modal would inert the workspace list behind it. */}
                      <MenuItems modal={false}>
                        <MenuAction
                          onClick={() => {
                            close();
                            openManagement(project);
                          }}
                        >
                          <Settings2 size={14} aria-hidden="true" />
                          {c.manageWorkspace}
                        </MenuAction>
                        <MenuAction
                          onClick={() => {
                            close();
                            setRenameTarget(project);
                          }}
                        >
                          <Pencil size={14} aria-hidden="true" />
                          {c.renameWorkspace}
                        </MenuAction>
                        <MenuAction
                          danger
                          aria-label={`${t("appRemoveProject")}: ${project.name}`}
                          onClick={(event) => {
                            close();
                            onRemoveRequest(event, project);
                          }}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          {t("appRemoveProject")}
                        </MenuAction>
                      </MenuItems>
                    </Menu>
                  </div>
                ))}
                {!filtered.length && (
                  <p className="workspace-switcher-empty" role="status">
                    {projects.length ? c.noWorkspaceMatches : c.noWorkspaces}
                  </p>
                )}
              </div>
              <div className="workspace-switcher-separator" />
              <Button
                variant="ghost"
                className="workspace-switcher-action"
                onClick={() => {
                  close();
                  onCreateProject();
                }}
              >
                <Plus size={16} aria-hidden="true" />
                {c.title}
              </Button>
            </PopoverPanel>
          </>
        )}
      </Popover>
      <span id={activityDescriptionId} className="sr-only" role="status" aria-atomic="true">
        {activityDescription}
      </span>
      <WorkspaceRenameDialog
        workspace={renameTarget}
        onClose={() => setRenameTarget(null)}
        onRenamed={() => setNotice(c.renamed)}
      />
      <span className="sr-only" role="status">
        {notice}
      </span>
    </>
  );
}
