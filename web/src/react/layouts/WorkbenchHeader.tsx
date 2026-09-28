import { Radio, RadioGroup } from "@headlessui/react";
import { ToolbarPill } from "./ToolbarPill";
import { GitToolbarTarget } from "../features/git/GitToolbarPortal";
import { useLocation } from "react-router-dom";
import { Terminal as TerminalIcon } from "lucide-react";
import { IslandSurface } from "./IslandSurface";
import { ThemeToggle } from "../components/ThemeToggle";
import { useTerminalStore } from "../features/terminal/terminalStore";
import { useState, useCallback, useEffect, useRef } from "react";
import { Menu, MenuButton, MenuAction, MenuOpenObserver } from "@/react/components/ui/Menu";
import { Popover, PopoverButton } from "@/react/components/ui/Popover";
import { Tooltip } from "@/react/components/ui/Tooltip";
import { IslandMenuItems, IslandPopoverPanel } from "./IslandOverlays";
import { IslandSelection } from "./IslandSelection";
import {
  Dialog,
  DialogContainer,
  DialogPanel,
  DialogHeader,
  DialogIcon,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "@/react/components/ui/Dialog";
import { Button } from "@/react/components/ui/Button";
import {
  BookOpen,
  GitMerge,
  Bot,
  Folder,
  Search,
  Settings2,
  Plus,
  Trash2,
  BookDashed,
  Ellipsis,
  Download,
  RotateCcw,
  Check,
  ChevronDown,
  Target,
} from "lucide-react";
import { useShellStore, type ProjectSummary } from "../state/shellStore";
import { useWikiStore, type WikiViewMode } from "../state/wikiStore";
import { useLocale } from "../../hooks/useLocale";
import { wikiApi } from "../../lib/api/wiki";
import { useAgentSessionStore } from "../features/agent-workspace/state/agentSessionStore";
import {
  useProjectSessionBadges,
  type ProjectSessionBadge,
} from "../features/agent-workspace/projectSessionBadges";
import { useSessionWorkspaceStore } from "../features/agent-workspace/state/sessionWorkspaceStore";
import { GoalMonitorPanel } from "../features/agent-workspace/GoalMonitorPanel";
import { ProjectImportHint } from "./ProjectImportHint";
import { WorkbenchIsland } from "./WorkbenchIsland";
import WikiSearchPanel from "../features/wiki/WikiSearchPanel";
import {
  useWikiSearch,
  type SearchResult,
} from "../features/wiki/WikiSearchPanel";
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

const navTabs: { id: ActivityPanel; icon: typeof BookOpen; label: string }[] = [
  { id: "sessions", icon: Bot, label: "Work" },
  { id: "wiki", icon: BookOpen, label: "Wiki" },
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
  const { t } = useLocale();
  const displayName = hasProject
    ? projectName
    : useShellStore.getState().preferences.locale === "zh"
      ? "切换项目"
      : "Switch project";
  const { badges, refresh: refreshBadges } = useProjectSessionBadges(
    projects.map((project) => project.id),
  );
  const currentBadge = badges[currentProjectId];

  return (
    <Menu>
      {({ open, close }) => <>
        <MenuOpenObserver open={open} onOpen={() => { onOpen?.(); void refreshBadges(); }} />
        <Tooltip content={displayName}>
          <MenuButton className={`wh-project-trigger ${iconOnly ? "wh-project-trigger--icon" : ""}`} aria-label={t("appSwitchProject")}>
            {iconOnly && <Folder size={15} aria-hidden="true" />}
            {!iconOnly && <span className="wh-project-label">{displayName}</span>}
            <ProjectSessionBadgeMark badge={currentBadge} className={iconOnly ? "project-session-badge--icon-trigger" : undefined} />
          </MenuButton>
        </Tooltip>
        <IslandMenuItems open={open} anchor={{ to: iconOnly ? "bottom start" : "top start", gap: 10, padding: 8 }} aria-label={t("appSwitchProject")} className="min-w-60">
          {projects.map(project => <div key={project.id} className="flex items-center gap-1" role="none">
            <MenuAction onClick={() => onProjectSwitch(project.id)} className="min-w-0 flex-1">
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <ProjectSessionBadgeMark badge={badges[project.id]} showCount />
              {project.id === currentProjectId && <Check size={13} aria-hidden="true" />}
            </MenuAction>
            <MenuAction danger className="!w-8 shrink-0 !p-2" aria-label={`${t("appRemoveProject")}: ${project.name}`} onClick={event => { close(); onRemoveRequest(event, project); }}>
              <Trash2 size={13} aria-hidden="true" />
            </MenuAction>
          </div>)}
          <MenuAction onClick={onCreateProject}><Plus size={14} aria-hidden="true" />{t("appImportProject")}</MenuAction>
        </IslandMenuItems>
      </>}
    </Menu>
  );
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
  const wikiEnabled = useShellStore((s) => s.preferences.wikiEnabled);

  return (
    <nav
      aria-label={t("workspaceMainNav")}
      className={`wh-tabs ${iconOnly ? "wh-tabs--icon-only" : ""}`}
    >
      <IslandSelection activeKey={activePanel} className="wh-tabs-list">
        {navTabs
          .filter((tab) => tab.id !== "wiki" || wikiEnabled)
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

function WikiToolbar({ visible }: { visible: boolean }) {
  const { t } = useLocale();
  const viewMode = useWikiStore((s) => s.viewMode);
  const setViewMode = useWikiStore((s) => s.setViewMode);
  const draftsReady = useWikiStore((s) => s.draftsSummary.ready);
  const draftsGenerating = useWikiStore((s) => s.draftsSummary.generating);
  const toggleDraftPanel = useWikiStore((s) => s.toggleDraftPanel);
  const draftPanelOpen = useWikiStore((s) => s.draftPanelOpen);
  const planGenStatus = useWikiStore((s) => s.planGeneration.status);
  const snapshot = useWikiStore((s) => s.snapshot);
  const selectDocument = useWikiStore((s) => s.selectDocument);
  const setSearchHighlightQuery = useWikiStore(
    (s) => s.setSearchHighlightQuery,
  );

  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { results } = useWikiSearch(query);

  useEffect(() => {
    if (!visible) return;
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearching(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visible]);

  useEffect(() => {
    if (searching) inputRef.current?.focus();
  }, [searching]);

  useEffect(() => {
    setActiveIndex(0);
  }, [results]);

  function handleSelect(result: SearchResult) {
    setViewMode("document");
    selectDocument(result.documentId);
    setSearchHighlightQuery(query.trim());
    closeSearch();
  }

  function closeSearch() {
    setSearching(false);
    setQuery("");
    setActiveIndex(0);
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[activeIndex]) {
      e.preventDefault();
      handleSelect(results[activeIndex]);
    }
  }

  if (searching) {
    return (
      <div data-searching className="relative">
        <div className="flex items-center gap-0.5">
          <div
            className="wh-btn !w-auto !px-2 gap-1.5 !cursor-text"
            onClick={() => inputRef.current?.focus()}
          >
            <Search size={13} className="text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t("wikiSearchPlaceholder")}
              className="w-[140px] bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <button
            type="button"
            className="wh-btn"
            title="Close"
            onMouseDown={(e) => {
              e.preventDefault();
              closeSearch();
            }}
          >
            <kbd className="text-[9px] text-muted-foreground">ESC</kbd>
          </button>
        </div>
        {query.trim() && (
          <>
            <div className="fixed inset-0 z-[9998]" onClick={closeSearch} />
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-[9999] w-[360px] rounded-xl border border-border/40 bg-card shadow-2xl overflow-hidden">
              <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 border-l border-t border-border/40 bg-card" />
              <WikiSearchPanel
                query={query}
                activeIndex={activeIndex}
                onActiveIndexChange={setActiveIndex}
                onSelect={handleSelect}
              />
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5">
      <RadioGroup
        value={viewMode}
        onChange={setViewMode}
        aria-label="Wiki"
        className="wiki-view-tabs"
      >
        <IslandSelection activeKey={viewMode} className="wiki-view-tabs-list flex items-center gap-1">
          <Radio
            as="button"
            type="button"
            value="document"
            data-island-option="document"
            className="wiki-view-tab rounded-lg px-2 py-1 text-xs data-checked:bg-primary/10 data-checked:text-primary focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span>{t("wikiDocument")}</span>
          </Radio>
          <Radio
            as="button"
            type="button"
            value="plan"
            data-island-option="plan"
            className="wiki-view-tab inline-flex items-center rounded-lg px-2 py-1 text-xs data-checked:bg-primary/10 data-checked:text-primary focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span>{t("wikiPlan")}</span>
            {planGenStatus === "generating" && (
              <span className="relative ml-0.5 flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 motion-reduce:animate-none" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
            )}
          </Radio>
        </IslandSelection>
      </RadioGroup>
      <div className="wh-divider" />
      <button
        type="button"
        className={`wh-btn relative ${draftPanelOpen ? "active" : ""}`}
        title="Drafts"
        onClick={toggleDraftPanel}
      >
        <BookDashed size={13} />
        {draftsReady > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-bold text-primary-foreground">
            {draftsReady}
          </span>
        )}
        {draftsGenerating > 0 && draftsReady === 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-primary" />
        )}
      </button>
      <button
        type="button"
        className="wh-btn"
        title={t("appSearch")}
        onClick={() => setSearching(true)}
      >
        <Search size={13} />
      </button>
      <Menu>
        {({ open }) => <>
        <Tooltip content={t("wikiTools")}><MenuButton className="wh-btn" aria-label={t("wikiTools")}><Ellipsis size={15} /></MenuButton></Tooltip>
        <IslandMenuItems open={open} aria-label={t("wikiTools")}>
          <MenuAction disabled={!snapshot} onClick={() => { if (snapshot) window.open(wikiApi.exportSnapshotUrl(snapshot.id), "_blank"); }}><Download size={14} />{t("wikiExportAll")}</MenuAction>
          <MenuAction danger onClick={() => useWikiStore.getState().setShowReinitConfirm(true)}><RotateCcw size={14} />{t("wikiReinitialize")}</MenuAction>
        </IslandMenuItems>
        </>}
      </Menu>
    </div>
  );
}

function WikiToolbarPill({ visible }: { visible: boolean }) {
  return (
    <ToolbarPill visible={visible}>
      <WikiToolbar visible={visible} />
    </ToolbarPill>
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [projectSwitcherUsed, setProjectSwitcherUsed] = useState(false);

  const handleRemoveClick = useCallback(
    (e: React.MouseEvent, project: ProjectSummary) => {
      e.stopPropagation();
      if (deleting) return;
      setDeleteError(null);
      setDeleteTarget(project);
      setConfirmOpen(true);
    },
    [deleting],
  );

  const handleConfirmRemove = useCallback(async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onRemoveProject(deleteTarget.id);
      setConfirmOpen(false);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, onRemoveProject]);

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

            <WikiToolbarPill visible={activePanel === "wiki"} />
            <GoalToolbarPill
              sessionId={goalSessionId}
              visible={hasProject && Boolean(goalSessionId)}
              iconOnly={compact}
            />
            <ToolbarPill visible={gitToolbarVisible}>
              <GitToolbarTarget />
            </ToolbarPill>
          </>

          {/* Remove project confirmation modal */}
          <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} dismissible={!deleting}>
            <>
              <DialogContainer size="sm">
                <DialogPanel>
                  <DialogHeader>
                    <DialogIcon className="bg-destructive/10 text-destructive">
                      <Trash2 size={18} />
                    </DialogIcon>
                    <DialogTitle>{t("appRemoveProject")}</DialogTitle>
                  </DialogHeader>
                  <DialogBody>
                    <p className="text-sm text-muted-foreground">
                      {t("appRemoveProjectConfirm", {
                        name: deleteTarget?.name ?? "",
                      })}
                    </p>
                    {deleteTarget?.id === currentProjectId && (
                      <p className="mt-2 text-xs text-warning">
                        {t("appRemoveProjectRunning")}
                      </p>
                    )}
                    {deleteError && <p role="alert" className="mt-2 text-sm text-destructive">{deleteError}</p>}
                  </DialogBody>
                  <DialogFooter>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={deleting}
                      onClick={() => {
                        setConfirmOpen(false);
                        setDeleteTarget(null);
                      }}
                    >
                      {t("appCancel")}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={deleting}
                      onClick={() => void handleConfirmRemove()}
                    >
                      {deleting ? t("appRemoving") : t("appConfirmRemove")}
                    </Button>
                  </DialogFooter>
                </DialogPanel>
              </DialogContainer>
            </>
          </Dialog>
        </div>
      )}
    </WorkbenchIsland>
  );
}
