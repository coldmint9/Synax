import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bot,
  Check,
  ChevronRight,
  FileCode2,
  FileDiff,
  Folder,
  FolderOpen,
  FolderTree,
  Layers2,
  Pin,
  GitBranch,
  GitCommit,
  List,
  RefreshCw,
} from "lucide-react";
import type {
  EnvironmentChangeStatus,
  SessionEnvironment,
  SessionEnvironmentFile,
  SessionEnvironmentInputSource,
  SessionEnvironmentRepository,
  SessionEnvironmentSubagent,
} from "../../../lib/api/agentRuntime";
import { WorkspaceSection as WorkspaceCard } from "./WorkspaceSection";
import { SessionTodoPanel } from "./SessionTodoPanel";
import { SessionProfilePanel } from "./SessionProfilePanel";
import { useAgentSessionStore } from "./agentSessionStore";
import { useWorkspaceCopy } from "../workspace/workspaceCopy";
import "../workspace/workspaceProjects.css";
import { copyTextToClipboard } from "../../../lib/clipboard";
import { useLocale } from "../../../hooks/useLocale";
import type { I18nKey } from "../../../lib/i18n";
import { FileTypeIcon } from "./FileTypeIcon";
import {
  openWorkspaceDiff,
  openWorkspaceFile,
  openWorkspaceSubagent,
  useSessionWorkspaceStore,
} from "./sessionWorkspaceStore";
import { SessionBackgroundProcesses } from "./SessionBackgroundProcesses";
import { useWorkspaceDisclosure } from "./useWorkspaceDisclosure";
import { RepositoryBranchPicker } from "./RepositoryBranchPicker";
import { SessionCommitDialog } from "./SessionCommitDialog";
import { useSessionEnvironment } from "./useSessionEnvironment";

const EMPTY_TODOS: import("../../../lib/api/agentRuntime").TodoItem[] = [];

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

interface ChangedFileDirectory {
  name: string;
  path: string;
  directories: ChangedFileDirectory[];
  files: SessionEnvironmentFile[];
}

/** Build a display-only directory tree without changing the environment API. */
function buildChangedFileTree(
  files: SessionEnvironmentFile[],
): ChangedFileDirectory {
  const root: ChangedFileDirectory = {
    name: "",
    path: "",
    directories: [],
    files: [],
  };
  const directories = new Map<string, ChangedFileDirectory>([["", root]]);

  for (const file of files) {
    const segments = file.path.split(/[\\/]/).filter(Boolean);
    segments.pop();
    let parent = root;
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let directory = directories.get(currentPath);
      if (!directory) {
        directory = {
          name: segment,
          path: currentPath,
          directories: [],
          files: [],
        };
        directories.set(currentPath, directory);
        parent.directories.push(directory);
      }
      parent = directory;
    }
    parent.files.push(file);
  }

  const sort = (directory: ChangedFileDirectory) => {
    directory.directories.sort((a, b) => a.name.localeCompare(b.name));
    directory.files.sort((a, b) =>
      fileName(a.path).localeCompare(fileName(b.path)),
    );
    directory.directories.forEach(sort);
  };
  sort(root);
  return root;
}

const STATUS_KEY: Record<string, I18nKey> = {
  queued: "workspaceStatusQueued",
  running: "workspaceStatusRunning",
  waiting_permission: "workspaceStatusWaitingPermission",
  waiting_input: "workspaceStatusWaitingInput",
  completed: "workspaceStatusCompleted",
  failed: "workspaceStatusFailed",
  cancelled: "workspaceStatusCancelled",
  interrupted: "workspaceStatusInterrupted",
};

function statusText(
  status: string,
  t: ReturnType<typeof useLocale>["t"],
): string {
  const key = STATUS_KEY[status];
  return key ? t(key) : status;
}

const STATUS_CHIP: Record<string, string> = {
  queued: "bg-primary/12 text-primary",
  running: "bg-[var(--color-run)]/15 text-[var(--color-run)]",
  waiting_permission: "bg-warning/15 text-warning",
  waiting_input: "bg-warning/15 text-warning",
  interrupted: "bg-warning/15 text-warning",
  completed: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-foreground/10 text-foreground/70",
};

const CHANGE_META: Record<
  EnvironmentChangeStatus,
  { letter: string; tone: string; labelKey: I18nKey }
> = {
  added: {
    letter: "A",
    tone: "bg-success/15 text-success",
    labelKey: "workspaceChangeAdded",
  },
  modified: {
    letter: "M",
    tone: "bg-warning/15 text-warning",
    labelKey: "workspaceChangeModified",
  },
  deleted: {
    letter: "D",
    tone: "bg-danger/15 text-danger",
    labelKey: "workspaceChangeDeleted",
  },
  renamed: {
    letter: "R",
    tone: "bg-primary/15 text-primary",
    labelKey: "workspaceChangeRenamed",
  },
  untracked: {
    letter: "U",
    tone: "bg-primary/15 text-primary",
    labelKey: "workspaceChangeUntracked",
  },
  unknown: {
    letter: "?",
    tone: "bg-foreground/10 text-muted-foreground",
    labelKey: "workspaceChangeUnknown",
  },
};

/**
 * Subagent sessions usually have no title of their own, so fall back to the
 * first heading line of the prompt instead of showing a column of "Subagent".
 */
function subagentHeadline(sub: SessionEnvironmentSubagent): string {
  const title = sub.title?.trim();
  if (title && title.toLowerCase() !== "subagent") return title;
  const [firstLine] = sub.prompt.split("\n");
  const cleaned = (firstLine ?? "").replace(/^#+\s*/, "").trim();
  return cleaned || "Subagent";
}

/** Prompt preview with the headline line removed so the two lines differ. */
function subagentPreview(sub: SessionEnvironmentSubagent): string {
  const lines = sub.prompt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const hasHeadline =
    !sub.title?.trim() || sub.title.trim().toLowerCase() === "subagent";
  const body = (hasHeadline ? lines.slice(1) : lines).join(" ");
  return body || sub.prompt.trim();
}

function ProjectSection({
  storageKey,
  icon,
  title,
  count,
  actions,
  children,
}: {
  storageKey: string;
  icon: React.ReactNode;
  title: string;
  count: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, toggle] = useWorkspaceDisclosure(storageKey);
  const id = useId();
  return (
    <section className="ws-project-section" data-open={open}>
      <div className="ws-project-section-head">
        <button
          type="button"
          className="ws-project-section-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={toggle}
        >
          <span className="ws-card-icon">{icon}</span>
          <span>{title}</span>
          <span className="ws-card-count">{count}</span>
          <ChevronRight
            size={11}
            className="ws-project-section-chevron"
            aria-hidden
          />
        </button>
        {actions && (
          <span className="ws-project-section-actions">{actions}</span>
        )}
      </div>
      {open && (
        <div id={id} className="ws-project-section-body">
          {children}
        </div>
      )}
    </section>
  );
}

function RepositoryProjectCard({
  sessionId,
  environment,
  repository,
  loading,
  reload,
  changedFilesView,
  onChangedFilesView,
  copiedPath,
  onCopyPath,
}: {
  sessionId: string;
  environment: SessionEnvironment;
  repository: SessionEnvironmentRepository;
  loading: boolean;
  reload: () => void | Promise<void>;
  changedFilesView: "tree" | "flat";
  onChangedFilesView: (view: "tree" | "flat") => void;
  copiedPath: string | null;
  onCopyPath: (path: string) => void;
}) {
  const { t } = useLocale();
  const outputFiles = repository.outputFiles ?? [];
  const changedFiles = repository.changedFiles;
  const changedFileTree = useMemo(
    () => buildChangedFileTree(changedFiles),
    [changedFiles],
  );
  const recentSources = (repository.inputSources ?? []).slice(-8).reverse();
  const stagedFiles = changedFiles.filter((file) => file.staged).length;
  const openDiff = (filePath: string) => {
    openWorkspaceDiff(sessionId, filePath, repository.rootId, repository.name);
  };

  return (
    <WorkspaceCard
      className="ws-project-card"
      storageKey={`${sessionId}:${repository.rootId}:project`}
      icon={<Folder size={13} />}
      title={repository.name}
      count={changedFiles.length || undefined}
      toolbar={
        <RepositoryCard
          environment={{ ...environment, ...repository }}
          repository={repository}
          loading={loading}
          reload={reload}
          embedded
        />
      }
    >
      {changedFiles.length > 0 && (
        <ProjectSection
          icon={<FileDiff size={13} />}
          storageKey={`${sessionId}:${repository.rootId}:changes`}
          title={t("workspaceCardGitChanges")}
          count={changedFiles.length}
          actions={
            <div className="ws-project-section-actions-group">
              <div
                className="ws-view-toggle"
                role="group"
                aria-label={t("workspaceChangeView")}
              >
                <button
                  type="button"
                  aria-label={t("workspaceTreeView")}
                  title={t("workspaceTreeView")}
                  aria-pressed={changedFilesView === "tree"}
                  onClick={() => onChangedFilesView("tree")}
                >
                  <FolderTree size={11} />
                </button>
                <button
                  type="button"
                  aria-label={t("workspaceFlatView")}
                  title={t("workspaceFlatView")}
                  aria-pressed={changedFilesView === "flat"}
                  onClick={() => onChangedFilesView("flat")}
                >
                  <List size={11} />
                </button>
              </div>
            </div>
          }
        >
          {stagedFiles > 0 && (
            <div className="ws-project-section-summary">
              {t("workspaceStagedCount", { count: stagedFiles })}
            </div>
          )}
          {changedFiles.length === 0 ? (
            <div className="ws-empty">{t("workspaceNoChanges")}</div>
          ) : changedFilesView === "tree" ? (
            <ChangedFileTree directory={changedFileTree} onOpen={openDiff} />
          ) : (
            changedFiles.map((file) => (
              <ChangedFileRow
                key={`${file.status}:${file.path}`}
                file={file}
                onOpen={() => openDiff(file.path)}
              />
            ))
          )}
        </ProjectSection>
      )}
      {recentSources.length > 0 && (
        <ProjectSection
          icon={<FileCode2 size={13} />}
          storageKey={`${sessionId}:${repository.rootId}:inputs`}
          title={t("workspaceCardInputSources")}
          count={recentSources.length}
        >
          {recentSources.map((source) => (
            <InputSourceRow
              key={`${source.kind}:${source.label}`}
              source={source}
              copied={copiedPath === source.label}
              onOpen={
                source.path
                  ? () =>
                      openWorkspaceFile(
                        sessionId,
                        source.path!,
                        null,
                        repository.rootId,
                        repository.name,
                      )
                  : undefined
              }
              onCopy={() => onCopyPath(source.label)}
            />
          ))}
        </ProjectSection>
      )}
      {outputFiles.length > 0 && (
        <ProjectSection
          icon={<FileCode2 size={13} />}
          storageKey={`${sessionId}:${repository.rootId}:outputs`}
          title={t("workspaceCardOutputs")}
          count={outputFiles.length}
        >
          <OutputFiles
            files={outputFiles}
            onOpen={(filePath) =>
              openWorkspaceFile(
                sessionId,
                filePath,
                null,
                repository.rootId,
                repository.name,
              )
            }
          />
        </ProjectSection>
      )}
    </WorkspaceCard>
  );
}

function WorkspaceProjectsPane({ sessionId, count, children }: { sessionId: string; count: number; children: React.ReactNode }) {
  const { locale } = useLocale();
  if (count === 1) return <div className="workspace-projects-pane">{children}</div>;
  return <WorkspaceCard className="workspace-projects-group" storageKey={`${sessionId}:projects`}
    icon={<Folder size={13} />} title={locale === "zh" ? "项目" : "Projects"} count={count}>{children}</WorkspaceCard>;
}

export const WorkspaceDashboard = memo(function WorkspaceDashboard({
  sessionId,
  environment: providedEnvironment,
  loading: providedLoading,
  reload: providedReload,
}: {
  sessionId: string | null;
  environment?: SessionEnvironment | null;
  loading?: boolean;
  reload?: () => void | Promise<void>;
}) {
  const { t, locale } = useLocale();
  const todos = useAgentSessionStore((state) =>
    state.selectedSessionId === sessionId ? state.sessionTodos : EMPTY_TODOS,
  );
  const c = useWorkspaceCopy();
  // The workspace panel already polls this snapshot; only fall back to owning
  // the request when rendered standalone.
  const owned = useSessionEnvironment(
    providedEnvironment === undefined ? sessionId : null,
  );
  const environment =
    providedEnvironment === undefined ? owned.environment : providedEnvironment;
  const loading = providedLoading ?? owned.loading;
  const reload = providedReload ?? owned.reload;
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [changedFilesView, setChangedFilesView] = useState<"tree" | "flat">(
    "flat",
  );
  const selectedRootId = useSessionWorkspaceStore((state) =>
    sessionId ? state.sessions[sessionId]?.selectedRootId : undefined,
  );
  const selectRepository = useSessionWorkspaceStore(
    (state) => state.selectRepository,
  );
  const repositories = environment?.repositories ?? [];
  const repository =
    repositories.find((root) => root.rootId === selectedRootId) ??
    repositories.find((root) => root.role === "primary") ??
    repositories[0];
  const repositoryEnvironment =
    environment && repository ? { ...environment, ...repository } : environment;
  const openDiff = (filePath: string) => {
    if (!sessionId) return;
    if (repository)
      openWorkspaceDiff(
        sessionId,
        filePath,
        repository.rootId,
        repository.name,
      );
    else openWorkspaceDiff(sessionId, filePath);
  };
  const copiedTimer = useRef<number | null>(null);

  const copyPath = useCallback(async (filePath: string) => {
    // Only claim success when the write actually landed.
    if (!(await copyTextToClipboard(filePath))) return;
    setCopiedPath(filePath);
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopiedPath(null), 1200);
  }, []);

  useEffect(
    () => () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const recentSources = useMemo(
    () => (repositoryEnvironment?.inputSources ?? []).slice(-8).reverse(),
    [repositoryEnvironment?.inputSources],
  );
  const changedFiles = repositoryEnvironment?.changedFiles ?? [];
  const outputFiles = repositoryEnvironment?.outputFiles ?? [];
  const changedFileTree = useMemo(
    () => buildChangedFileTree(changedFiles),
    [changedFiles],
  );
  const subagents = environment?.subagents ?? [];
  const runningSubagents = subagents.filter(
    (sub) => sub.status === "running",
  ).length;
  const stagedFiles = changedFiles.filter((file) => file.staged).length;

  if (sessionId && environment && repositories.length > 0) {
    return (
      <div className="workspace-dashboard workspace-dashboard--pinned session-workspace-scroll min-h-0 flex-1">
        <SessionTodoPanel key={sessionId} items={todos} />
        <WorkspaceProjectsPane sessionId={sessionId} count={repositories.length}>
          {repositories.map((root) => (
            <RepositoryProjectCard
              key={root.rootId}
              sessionId={sessionId}
              environment={environment}
              repository={root}
              loading={loading}
              reload={reload}
              changedFilesView={changedFilesView}
              onChangedFilesView={setChangedFilesView}
              copiedPath={copiedPath}
              onCopyPath={(path) => void copyPath(path)}
            />
          ))}
        </WorkspaceProjectsPane>
        {subagents.length > 0 && (
          <WorkspaceCard
            icon={<Bot size={13} />}
            title={t("workspaceCardSubagents")}
            count={subagents.length}
            summary={
              runningSubagents > 0
                ? t("workspaceRunningCount", { count: runningSubagents })
                : null
            }
          >
            {subagents.map((sub) => (
              <SubagentRow
                key={sub.id}
                sub={sub}
                onOpen={() =>
                  openWorkspaceSubagent(
                    sessionId,
                    sub.id,
                    subagentHeadline(sub),
                  )
                }
              />
            ))}
          </WorkspaceCard>
        )}
        <SessionBackgroundProcesses sessionId={sessionId} environment={environment} />
        <SessionProfilePanel sessionId={sessionId} />
      </div>
    );
  }

  return (
    <div className="workspace-dashboard session-workspace-scroll min-h-0 flex-1 overflow-y-auto">
      {sessionId && <SessionTodoPanel items={todos} />}
      {!sessionId ? (
        <div className="ws-placeholder">{t("workspaceSelectSession")}</div>
      ) : environment && repositoryEnvironment ? (
        <>
          {repositories.length > 1 && (
            <section className="ws-project-switcher" aria-label={c.members}>
              <div className="workspace-section-label">
                <span className="flex items-center gap-1.5">
                  <Layers2 size={12} />
                  {c.members}
                </span>
                <span className="workspace-count">{repositories.length}</span>
              </div>
              <div
                className="ws-project-options"
                role="group"
                aria-label={t("workspaceRepositorySelect")}
              >
                {repositories.map((root) => (
                  <button
                    key={root.rootId}
                    type="button"
                    className="ws-project-option"
                    aria-pressed={repository?.rootId === root.rootId}
                    aria-label={root.name}
                    onClick={() => selectRepository(sessionId, root.rootId)}
                  >
                    <span className="ws-project-option-top">
                      <Folder size={13} />
                      <strong title={root.name}>{root.name}</strong>
                      {root.role === "primary" && (
                        <Pin size={10} aria-label={c.primary} />
                      )}
                      <span
                        className="ws-project-change-count"
                        data-dirty={root.changedFiles.length > 0 || undefined}
                      >
                        {root.status === "ready"
                          ? root.changedFiles.length || <Check size={10} />
                          : "!"}
                      </span>
                    </span>
                    <span className="ws-project-option-meta">
                      {root.status === "ready" ? (
                        <>
                          <GitBranch size={10} />
                          <span>{root.branch}</span>
                        </>
                      ) : (
                        <span className="text-warning">
                          {t(
                            root.status === "missing"
                              ? "workspaceRepositoryMissing"
                              : root.status === "not_repository"
                                ? "workspaceRepositoryNotGit"
                                : "workspaceRepositoryError",
                          )}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {(!repository || repository.status !== "ready") && (
            <RepositoryCard
              key={`${sessionId}:${repository?.rootId ?? "primary"}`}
              environment={repositoryEnvironment}
              repository={repository}
              loading={loading}
              reload={reload}
            />
          )}
          {(!repository || repository.status === "ready") &&
            changedFiles.length > 0 && (
              <WorkspaceCard
                icon={<FileDiff size={13} />}
                title={t("workspaceCardGitChanges")}
                count={changedFiles.length}
                actions={
                  <div
                    className="ws-view-toggle"
                    role="group"
                    aria-label={t("workspaceChangeView")}
                  >
                    <button
                      type="button"
                      aria-label={t("workspaceTreeView")}
                      title={t("workspaceTreeView")}
                      aria-pressed={changedFilesView === "tree"}
                      onClick={() => setChangedFilesView("tree")}
                    >
                      <FolderTree size={11} />
                    </button>
                    <button
                      type="button"
                      aria-label={t("workspaceFlatView")}
                      title={t("workspaceFlatView")}
                      aria-pressed={changedFilesView === "flat"}
                      onClick={() => setChangedFilesView("flat")}
                    >
                      <List size={11} />
                    </button>
                  </div>
                }
                summary={
                  stagedFiles > 0
                    ? t("workspaceStagedCount", { count: stagedFiles })
                    : null
                }
              >
                {changedFiles.length === 0 ? (
                  <div className="ws-empty">{t("workspaceNoChanges")}</div>
                ) : changedFilesView === "tree" ? (
                  <ChangedFileTree
                    key={repository?.rootId}
                    directory={changedFileTree}
                    onOpen={openDiff}
                  />
                ) : (
                  changedFiles.map((file) => (
                    <ChangedFileRow
                      key={`${file.status}:${file.path}`}
                      file={file}
                      onOpen={() => openDiff(file.path)}
                    />
                  ))
                )}
              </WorkspaceCard>
            )}

          {recentSources.length > 0 && (
            <WorkspaceCard
              defaultOpen={false}
              icon={<FileCode2 size={13} />}
              title={t("workspaceCardInputSources")}
              count={recentSources.length}
            >
              {recentSources.map((source) => (
                <InputSourceRow
                  key={`${source.kind}:${source.label}`}
                  source={source}
                  copied={copiedPath === source.label}
                  onOpen={
                    source.path
                      ? () =>
                          repository
                            ? openWorkspaceFile(
                                sessionId,
                                source.path!,
                                null,
                                repository.rootId,
                                repository.name,
                              )
                            : openWorkspaceFile(sessionId, source.path!)
                      : undefined
                  }
                  onCopy={() => void copyPath(source.label)}
                />
              ))}
            </WorkspaceCard>
          )}
          {outputFiles.length > 0 && (
            <WorkspaceCard
              icon={<FileCode2 size={13} />}
              title={t("workspaceCardOutputs")}
              count={outputFiles.length}
            >
              <OutputFiles
                files={outputFiles}
                onOpen={(filePath) =>
                  openWorkspaceFile(
                    sessionId,
                    filePath,
                    null,
                    repository?.rootId,
                    repository?.name,
                  )
                }
              />
            </WorkspaceCard>
          )}
          {/* Only meaningful once the session actually spawned subagents — an
              empty placeholder here is pure noise. */}
          {subagents.length > 0 ? (
            <WorkspaceCard
              icon={<Bot size={13} />}
              title={t("workspaceCardSubagents")}
              count={subagents.length}
              summary={
                runningSubagents > 0
                  ? t("workspaceRunningCount", { count: runningSubagents })
                  : null
              }
            >
              {subagents.map((sub) => (
                <SubagentRow
                  key={sub.id}
                  sub={sub}
                  onOpen={() =>
                    openWorkspaceSubagent(
                      sessionId,
                      sub.id,
                      subagentHeadline(sub),
                    )
                  }
                />
              ))}
            </WorkspaceCard>
          ) : null}
        </>
      ) : loading ? (
        <div className="ws-placeholder">{t("workspaceLoading")}</div>
      ) : null}
      {sessionId && (
        <>
          <SessionBackgroundProcesses key={sessionId} sessionId={sessionId} environment={environment} />
          <SessionProfilePanel sessionId={sessionId} />
        </>
      )}
    </div>
  );
});

function ChangedFileTree({
  directory,
  onOpen,
  depth = 0,
}: {
  directory: ChangedFileDirectory;
  onOpen: (path: string) => void;
  depth?: number;
}) {
  return (
    <>
      {directory.directories.map((child) => (
        <ChangedFileFolder
          key={child.path}
          directory={child}
          onOpen={onOpen}
          depth={depth}
        />
      ))}
      {directory.files.map((file) => (
        <ChangedFileRow
          key={`${file.status}:${file.path}`}
          file={file}
          depth={depth}
          onOpen={() => onOpen(file.path)}
        />
      ))}
    </>
  );
}

function ChangedFileFolder({
  directory,
  onOpen,
  depth,
}: {
  directory: ChangedFileDirectory;
  onOpen: (path: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const FolderIcon = expanded ? FolderOpen : Folder;

  return (
    <div className="ws-tree-directory" data-directory-path={directory.path}>
      <button
        type="button"
        className="ws-tree-folder"
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        title={directory.path}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight size={10} className="ws-tree-chevron" />
        <FolderIcon size={12} className="ws-tree-folder-icon" />
        <span>{directory.name}</span>
      </button>
      {expanded ? (
        <ChangedFileTree
          directory={directory}
          onOpen={onOpen}
          depth={depth + 1}
        />
      ) : null}
    </div>
  );
}

function RepositoryCard({
  environment,
  repository,
  loading,
  reload,
  embedded = false,
}: {
  environment: SessionEnvironment;
  repository?: SessionEnvironmentRepository;
  loading: boolean;
  reload: () => void | Promise<void>;
  embedded?: boolean;
}) {
  const { t } = useLocale();
  const [commitOpen, setCommitOpen] = useState(false);
  const changedCount = environment.changedFiles.length;
  const unavailable = repository && repository.status !== "ready";
  return (
    <section
      className={embedded ? "ws-project-repository" : "ws-card ws-card--repo"}
    >
      {repository && !embedded && (
        <div className="ws-repo-project">
          <Folder size={12} />
          <strong>{repository.name}</strong>
        </div>
      )}
      <div className="ws-repo-head">
        <RepositoryBranchPicker
          key={`${environment.sessionId}:${repository?.rootId ?? "primary"}`}
          sessionId={environment.sessionId}
          rootId={repository?.rootId}
          branch={environment.branch}
          disabled={loading || unavailable}
          onSwitched={() => void reload()}
        />
        <span
          className={`ws-repo-state ${unavailable ? "bg-warning/15 text-warning" : environment.dirty ? "bg-warning/15 text-warning" : "bg-success/15 text-success"}`}
        >
          {unavailable
            ? t(
                repository.status === "missing"
                  ? "workspaceRepositoryMissing"
                  : repository.status === "not_repository"
                    ? "workspaceRepositoryNotGit"
                    : "workspaceRepositoryError",
              )
            : environment.dirty
              ? t("workspaceChangeModified")
              : t("workspaceNoChanges")}
        </span>
        <button
          type="button"
          className="ws-repo-action"
          onClick={() => setCommitOpen(true)}
          disabled={loading || unavailable || changedCount === 0}
          title={t("workspaceCommitPush")}
        >
          <GitCommit size={10} />
          <span>{t("workspaceCommitPush")}</span>
        </button>
        <button
          type="button"
          className="ws-icon-button"
          onClick={() => void reload()}
          disabled={loading}
          aria-label={t("workspaceRefresh")}
          title={t("workspaceRefresh")}
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <SessionCommitDialog
        isOpen={commitOpen}
        sessionId={environment.sessionId}
        rootId={repository?.rootId}
        rootName={repository?.name}
        branch={environment.branch}
        changedFiles={changedCount}
        onClose={() => setCommitOpen(false)}
        onCommitted={() => void reload()}
      />
    </section>
  );
}

function SubagentRow({
  sub,
  onOpen,
}: {
  sub: SessionEnvironmentSubagent;
  onOpen: () => void;
}) {
  const { t } = useLocale();
  return (
    <button type="button" className="ws-row ws-row--subagent" onClick={onOpen}>
      <Bot size={11} className="ws-row-icon" />
      <span className="ws-row-main">
        <span className="ws-row-file">{subagentHeadline(sub)}</span>
        <span className="ws-row-sub">{subagentPreview(sub)}</span>
      </span>
      <span
        className={`ws-chip ${STATUS_CHIP[sub.status] ?? "bg-foreground/10 text-foreground/70"}`}
      >
        {statusText(sub.status, t)}
      </span>
    </button>
  );
}

function ChangedFileRow({
  file,
  onOpen,
  depth = 0,
}: {
  file: SessionEnvironmentFile;
  onOpen: () => void;
  depth?: number;
}) {
  const { t } = useLocale();
  const meta = CHANGE_META[file.status] ?? CHANGE_META.unknown;
  const name = fileName(file.path);
  const hasStats = file.additions > 0 || file.deletions > 0;

  return (
    <button
      type="button"
      className="ws-row"
      style={{ paddingLeft: `${6 + depth * 14}px` }}
      title={file.path}
      onClick={onOpen}
    >
      <FileTypeIcon path={file.path} size={11} />
      <span className={`ws-badge ${meta.tone}`} title={t(meta.labelKey)}>
        {meta.letter}
      </span>
      <span className="ws-row-main ws-row-main--file">
        <span className="ws-row-file">{name}</span>
      </span>
      {hasStats ? (
        <span className="ws-row-diff ws-mono">
          {file.additions > 0 ? (
            <span className="text-success">+{file.additions}</span>
          ) : null}
          {file.deletions > 0 ? (
            <span className="text-danger">-{file.deletions}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

function OutputFiles({
  files,
  onOpen,
}: {
  files: string[];
  onOpen: (path: string) => void;
}) {
  const { t } = useLocale();
  if (!files.length) return null;
  return files.map((filePath) => (
    <button
      key={filePath}
      type="button"
      className="ws-row"
      title={filePath}
      onClick={() => onOpen(filePath)}
    >
      <FileTypeIcon path={filePath} size={11} />
      <span className="ws-row-main">
        <span className="ws-row-file">{fileName(filePath)}</span>
        <span className="ws-row-sub">
          {filePath.includes("/")
            ? filePath.slice(0, filePath.lastIndexOf("/"))
            : t("workspaceRootDirectory")}
        </span>
      </span>
    </button>
  ));
}

function InputSourceRow({
  source,
  copied,
  onOpen,
  onCopy,
}: {
  source: SessionEnvironmentInputSource;
  copied: boolean;
  onOpen?: () => void;
  onCopy: () => void;
}) {
  const label = source.path ? fileName(source.path) : source.label;

  return (
    <button
      type="button"
      className="ws-row"
      title={source.label}
      onClick={onOpen}
      disabled={!onOpen}
      onContextMenu={(event) => {
        event.preventDefault();
        onCopy();
      }}
    >
      <FileTypeIcon path={source.path ?? "source"} size={11} />
      <span className="ws-row-main ws-row-main--file">
        <span className="ws-row-file">{label}</span>
        <span className="ws-row-sub">{source.kind}</span>
      </span>
      {copied ? <Check size={11} className="ws-row-icon text-success" /> : null}
    </button>
  );
}
