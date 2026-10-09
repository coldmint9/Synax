import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
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
import { MenuOpenObserver } from "@/shared/ui/ui/Menu";
import { Button } from "@/shared/ui/ui/Button";
import { Input } from "@/shared/ui/ui/Field";
import { Tooltip } from "@/shared/ui/ui/Tooltip";
import type { ProjectSummary } from "../../shared/state/shellStore";
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
  badge?: ReactNode;
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
  badge,
  renderBadge,
}: Props) {
  const c = useWorkspaceCopy();
  const { t } = useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);
  const [notice, setNotice] = useState("");
  const actionButtons = useRef(new Map<string, HTMLButtonElement>());
  const backRef = useRef<HTMLButtonElement>(null);
  const target = projects.find((project) => project.id === targetId);
  const filtered = projects.filter((project) =>
    project.name
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  const displayName = hasProject ? projectName : c.switchWorkspace;
  const back = () => {
    const id = targetId;
    setTargetId(null);
    requestAnimationFrame(() => {
      if (id) actionButtons.current.get(id)?.focus();
    });
  };
  return (
    <>
      <Popover>
        {({ open, close }) => (
          <>
            <MenuOpenObserver
              open={open}
              onOpen={() => {
                setSearch("");
                setTargetId(null);
                onOpen?.();
              }}
            />
            <Tooltip content={displayName}>
              <PopoverButton
                className={`wh-project-trigger ${iconOnly ? "wh-project-trigger--icon" : ""}`}
                aria-label={t("appSwitchProject")}
              >
                <Folder size={15} aria-hidden="true" />
                {!iconOnly && (
                  <span className="wh-project-label">{displayName}</span>
                )}
                {badge}
                {!iconOnly && <ChevronDown size={12} aria-hidden="true" />}
              </PopoverButton>
            </Tooltip>
            <PopoverPanel
              focus
              anchor={{ to: "bottom start", gap: 8, padding: 8 }}
              className="workspace-switcher"
              aria-label={c.switchWorkspace}
              onKeyDownCapture={(event) => {
                if (event.key === "Escape" && target) {
                  event.preventDefault();
                  event.stopPropagation();
                  back();
                }
              }}
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
              {target ? (
                <>
                  <Button
                    ref={backRef}
                    variant="ghost"
                    className="workspace-switcher-action"
                    onClick={back}
                  >
                    <ArrowLeft size={15} />
                    {c.backWorkspaceList}
                  </Button>
                  <div className="workspace-switcher-target">
                    <Folder size={18} aria-hidden="true" />
                    <span title={target.name}>{target.name}</span>
                    {target.id === currentProjectId && (
                      <Check size={15} aria-label={c.currentWorkspace} />
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    className="workspace-switcher-action"
                    onClick={() => {
                      close();
                      navigate(
                        `/workspaces/${encodeURIComponent(target.id)}/manage`,
                        {
                          state: {
                            workspaceReturnTo:
                              location.pathname + location.search,
                          },
                        },
                      );
                    }}
                  >
                    <Settings2 size={15} />
                    {c.manageWorkspace}
                  </Button>
                  <Button
                    variant="ghost"
                    className="workspace-switcher-action"
                    onClick={() => {
                      close();
                      setRenameTarget(target);
                    }}
                  >
                    <Pencil size={15} />
                    {c.renameWorkspace}
                  </Button>
                  <div className="workspace-switcher-separator" />
                  <Button
                    variant="ghost"
                    className="workspace-switcher-action"
                    data-danger
                    aria-label={`${t("appRemoveProject")}: ${target.name}`}
                    onClick={(event) => {
                      close();
                      onRemoveRequest(event, target);
                    }}
                  >
                    <Trash2 size={15} />
                    {t("appRemoveProject")}
                  </Button>
                </>
              ) : (
                <>
                  <div className="workspace-switcher-heading">
                    {c.workspaces}
                  </div>
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
                        data-current={
                          project.id === currentProjectId || undefined
                        }
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
                          <span
                            className="workspace-switcher-name"
                            title={project.name}
                          >
                            {project.name}
                          </span>
                          {renderBadge(project.id)}
                          {project.id === currentProjectId && (
                            <Check size={14} aria-label={c.currentWorkspace} />
                          )}
                        </Button>
                        <Button
                          ref={(element) => {
                            if (element)
                              actionButtons.current.set(project.id, element);
                            else actionButtons.current.delete(project.id);
                          }}
                          className="workspace-switcher-more"
                          iconOnly
                          variant="ghost"
                          aria-label={`${c.workspaceMore}: ${project.name}`}
                          onClick={() => {
                            setTargetId(project.id);
                            requestAnimationFrame(() =>
                              backRef.current?.focus(),
                            );
                          }}
                        >
                          <Ellipsis size={16} />
                        </Button>
                      </div>
                    ))}
                    {!filtered.length && (
                      <p className="workspace-switcher-empty" role="status">
                        {projects.length
                          ? c.noWorkspaceMatches
                          : c.noWorkspaces}
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
                    <Plus size={16} />
                    {c.title}
                  </Button>
                </>
              )}
            </PopoverPanel>
          </>
        )}
      </Popover>
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
