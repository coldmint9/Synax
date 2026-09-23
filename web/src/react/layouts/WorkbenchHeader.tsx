import { ToolbarPill } from "./ToolbarPill";
import { GitToolbarTarget } from "../features/git/GitToolbarPortal";
import { useLocation } from "react-router-dom";
import { Terminal as TerminalIcon } from "lucide-react";
import { ThemeToggle } from "../components/ThemeToggle";
import { useTerminalStore } from "../features/terminal/terminalStore";
import {
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { Tabs, Dropdown, Modal, Button, useOverlayState } from "@heroui/react";
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
  const labelRef = useRef<HTMLSpanElement>(null);
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
    <Dropdown
      onOpenChange={(isOpen) => {
        if (isOpen) {
          onOpen?.();
          void refreshBadges();
        }
      }}
    >
      <Dropdown.Trigger>
        <div
          role="button"
          tabIndex={0}
          className={`wh-project-trigger ${iconOnly ? "wh-project-trigger--icon" : ""}`}
          title={displayName}
          aria-label={t("appSwitchProject")}
        >
          {iconOnly ? (
            <>
              <Folder size={14} />
              <ProjectSessionBadgeMark
                badge={currentBadge}
                className="project-session-badge--icon-trigger"
              />
            </>
          ) : (
            <>
              <ProjectSessionBadgeMark badge={currentBadge} />
              <span
                ref={labelRef}
                className="wh-project-label text-xs font-medium"
                onMouseEnter={() =>
                  labelRef.current?.scrollTo({
                    left: labelRef.current.scrollWidth,
                    behavior: "smooth",
                  })
                }
                onMouseLeave={() =>
                  labelRef.current?.scrollTo({ left: 0, behavior: "smooth" })
                }
              >
                {displayName}
              </span>
            </>
          )}
        </div>
      </Dropdown.Trigger>
      <Dropdown.Popover placement={iconOnly ? "bottom start" : "top start"}>
        <Dropdown.Menu
          aria-label={t("appSwitchProject")}
          onAction={(key) => {
            if (key === "__create__") onCreateProject();
            else onProjectSwitch(key as string);
          }}
        >
          {projects.map((project) => (
            <Dropdown.Item
              key={project.id}
              id={project.id}
              textValue={project.name}
            >
              <div className="flex items-center justify-between w-full gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="text-xs truncate min-w-0">
                    {project.name}
                  </span>
                  <ProjectSessionBadgeMark
                    badge={badges[project.id]}
                    showCount
                  />
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  className="shrink-0 p-0.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition cursor-pointer"
                  onClick={(event) => onRemoveRequest(event, project)}
                >
                  <Trash2 size={11} />
                </span>
              </div>
            </Dropdown.Item>
          ))}
          <Dropdown.Item
            key="__create__"
            id="__create__"
            textValue={t("appImportProject")}
          >
            <span className="flex items-center gap-1.5 text-xs text-primary">
              <Plus size={12} />
              {t("appImportProject")}
            </span>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
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
    <Tabs
      selectedKey={activePanel ?? ""}
      onSelectionChange={(key) => onPanelToggle(key as ActivityPanel)}
      className={`wh-tabs ${iconOnly ? "wh-tabs--icon-only" : ""}`}
    >
      <Tabs.List aria-label={t("workspaceMainNav")} className="wh-tabs-list">
        {navTabs
          .filter((tab) => tab.id !== "wiki" || wikiEnabled)
          .map((tab, i) => {
            const Icon = tab.icon;
            return (
              <Tabs.Tab
                key={tab.id}
                id={tab.id}
                isDisabled={!hasProject}
                onPress={() => {
                  if (activePanel === tab.id) onPanelToggle(tab.id);
                }}
                aria-label={tab.label}
                className={`wh-tab wh-tab--${tab.id}`}
              >
                {i > 0 && <Tabs.Separator />}
                {iconOnly ? (
                  <span className="inline-flex" title={tab.label}>
                    <Icon size={13} />
                  </span>
                ) : (
                  <>
                    <Icon size={13} />
                    <span>{tab.label}</span>
                  </>
                )}
                <Tabs.Indicator />
              </Tabs.Tab>
            );
          })}
      </Tabs.List>
    </Tabs>
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
      <Tabs
        selectedKey={viewMode}
        onSelectionChange={(key) => setViewMode(key as WikiViewMode)}
        className="wiki-view-tabs"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="Wiki" className="wiki-view-tabs-list">
            <Tabs.Tab id="document" className="wiki-view-tab">
              <span>{t("wikiDocument")}</span>
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="plan" className="wiki-view-tab">
              <span>{t("wikiPlan")}</span>
              {planGenStatus === "generating" && (
                <span className="relative flex h-2 w-2 ml-0.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
              )}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
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
      <Dropdown>
        <Dropdown.Trigger>
          <div role="button" tabIndex={0} className="wh-btn" title="Tools">
            <Ellipsis size={13} />
          </div>
        </Dropdown.Trigger>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label={t("wikiTools")}
            onAction={(key) => {
              if (key === "export" && snapshot) {
                window.open(wikiApi.exportSnapshotUrl(snapshot.id), "_blank");
              } else if (key === "reinit") {
                useWikiStore.getState().setShowReinitConfirm(true);
              }
            }}
          >
            <Dropdown.Item
              key="export"
              id="export"
              textValue={t("wikiExportAll")}
            >
              <span className="flex items-center gap-2 text-xs">
                <Download size={12} />
                {t("wikiExportAll")}
              </span>
            </Dropdown.Item>
            <Dropdown.Item
              key="reinit"
              id="reinit"
              textValue={t("wikiReinitialize")}
            >
              <span className="flex items-center gap-2 text-xs text-destructive">
                <RotateCcw size={12} />
                {t("wikiReinitialize")}
              </span>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
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
  const gitToolbarVisible =
    activePanel === "git" && !location.pathname.includes("/git/mr/");
  const confirmState = useOverlayState();
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [projectSwitcherUsed, setProjectSwitcherUsed] = useState(false);

  const handleRemoveClick = useCallback(
    (e: React.MouseEvent, project: ProjectSummary) => {
      e.stopPropagation();
      setDeleteTarget(project);
      confirmState.open();
    },
    [confirmState],
  );

  const handleConfirmRemove = useCallback(async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await onRemoveProject(deleteTarget.id);
      confirmState.close();
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, onRemoveProject, confirmState]);

  const selectedSessionId = useAgentSessionStore((s) => s.selectedSessionId);
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
            <div className="wh-pill">
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
                <button
                  type="button"
                  className="wh-btn"
                  aria-label={
                    useShellStore.getState().preferences.locale === "zh"
                      ? "终端"
                      : "Terminal"
                  }
                  title={
                    useShellStore.getState().preferences.locale === "zh"
                      ? "终端"
                      : "Terminal"
                  }
                  onClick={() => useTerminalStore.getState().toggle()}
                >
                  <TerminalIcon size={15} />
                </button>
                <button
                  type="button"
                  className="wh-btn"
                  title={t("appSettings")}
                  aria-label={t("appSettings")}
                  onClick={() => onPanelToggle("settings")}
                >
                  <Settings2 size={15} />
                </button>
                <ThemeToggle />
              </div>
            </div>

            <WikiToolbarPill visible={activePanel === "wiki"} />
            <ToolbarPill visible={gitToolbarVisible}>
              <GitToolbarTarget />
            </ToolbarPill>
          </>

          {/* Remove project confirmation modal */}
          <Modal state={confirmState}>
            <Modal.Backdrop>
              <Modal.Container size="sm">
                <Modal.Dialog>
                  <Modal.Header>
                    <Modal.Icon className="bg-destructive/10 text-destructive">
                      <Trash2 size={18} />
                    </Modal.Icon>
                    <Modal.Heading>{t("appRemoveProject")}</Modal.Heading>
                  </Modal.Header>
                  <Modal.Body>
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
                  </Modal.Body>
                  <Modal.Footer>
                    <Button
                      variant="ghost"
                      size="sm"
                      isDisabled={deleting}
                      onPress={() => {
                        confirmState.close();
                        setDeleteTarget(null);
                      }}
                    >
                      {t("appCancel")}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      isDisabled={deleting}
                      onPress={() => void handleConfirmRemove()}
                    >
                      {deleting ? t("appRemoving") : t("appConfirmRemove")}
                    </Button>
                  </Modal.Footer>
                </Modal.Dialog>
              </Modal.Container>
            </Modal.Backdrop>
          </Modal>
        </div>
      )}
    </WorkbenchIsland>
  );
}
