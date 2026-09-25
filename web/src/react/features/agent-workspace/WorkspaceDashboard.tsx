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
  MoreHorizontal,
} from "lucide-react";
import type {
  EnvironmentChangeStatus,
  SessionEnvironment,
  SessionEnvironmentFile,
  SessionEnvironmentInputSource,
  SessionEnvironmentRepository,
  SessionEnvironmentSubagent,
} from "../../../lib/api/agentRuntime";
import {
  DashboardPanel,
  WorkspaceDashboardLayout,
} from "./WorkspaceDashboardLayout";
import { WorkspaceSection as WorkspaceCard } from "./WorkspaceSection";
import { WorkspaceFilesCard } from "./WorkspaceFilesCard";
import { SessionTodoPanel } from "./SessionTodoPanel";
import { SessionProfilePanel } from "./SessionProfilePanel";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { SubagentControls } from "./SubagentControls";
import { useWorkspaceCopy } from "../workspace/workspaceCopy";
import "../workspace/workspaceProjects.css";
import { useLocale } from "../../../hooks/useLocale";
import { useContextMenu } from "../../components/context-menu/ContextMenuProvider";
import { fileContextEntries, sourceContextEntries } from "./workspaceContextMenus";
import type { I18nKey } from "../../../lib/i18n";
import { agentRuntimeApi } from "../../../lib/api/agentRuntime";
import { FileTypeIcon } from "./FileTypeIcon";
import {
  openWorkspaceDiff,
  openWorkspaceFile,
  openWorkspaceInputSource,
  openWorkspaceSubagent,
  useSessionWorkspaceStore,
} from "./state/sessionWorkspaceStore";
import { SessionBackgroundProcesses } from "./SessionBackgroundProcesses";
import { useWorkspaceDisclosure } from "./useWorkspaceDisclosure";
import { RepositoryBranchPicker } from "./RepositoryBranchPicker";
import { SessionCommitDialog } from "./SessionCommitDialog";
import { useSessionEnvironment } from "./useSessionEnvironment";
import { getProjectThemeColor } from "./projectThemeColor";

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
  onRevert,
  revertingPaths,
}: {
  sessionId: string;
  environment: SessionEnvironment;
  repository: SessionEnvironmentRepository;
  loading: boolean;
  reload: () => void | Promise<void>;
  changedFilesView: "tree" | "flat";
  onChangedFilesView: (view: "tree" | "flat") => void;
  onRevert?: (file: SessionEnvironmentFile, rootId?: string) => void;
  revertingPaths?: ReadonlySet<string>;
}) {
  const { t } = useLocale();
  const changedFiles = repository.changedFiles;
  const changedFileTree = useMemo(
    () => buildChangedFileTree(changedFiles),
    [changedFiles],
  );
  const stagedFiles = changedFiles.filter((file) => file.staged).length;
  const hasProjectRecords = changedFiles.length > 0;
  const projectColor =
    (environment.repositories?.length ?? 0) > 1
      ? getProjectThemeColor(repository.rootId)
      : "default";
  const openDiff = (filePath: string) => {
    openWorkspaceDiff(sessionId, filePath, repository.rootId, repository.name);
  };

  return (
    <WorkspaceCard
      className={`ws-project-card ${hasProjectRecords ? "ws-project-card--with-content" : "ws-project-card--status-only"}`}
      storageKey={`${sessionId}:${repository.rootId}:project`}
      icon={
        <span
          className="ws-project-folder-icon"
          data-project-color={projectColor}
        >
          <Folder size={13} />
        </span>
      }
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
          {changedFilesView === "tree" ? (
            <ChangedFileTree
              directory={changedFileTree}
              onOpen={openDiff}
              onRevert={onRevert}
              revertingPaths={revertingPaths}
              sessionId={sessionId}
              rootId={repository.rootId}
              rootName={repository.name}
              workspacePath={repository.workspacePath}
            />
          ) : (
            changedFiles.map((file) => (
              <ChangedFileRow
                key={`${file.status}:${file.path}`}
                file={file}
                onOpen={() => openDiff(file.path)}
                onRevert={onRevert}
                reverting={revertingPaths?.has(`${repository.rootId}:${file.path}`) ?? false}
                sessionId={sessionId}
                rootId={repository.rootId}
                rootName={repository.name}
                workspacePath={repository.workspacePath}
              />
            ))
          )}
        </ProjectSection>
      )}
    </WorkspaceCard>
  );
}

function WorkspaceFilesDashboardPanel({
  sessionId,
  repositories,
  inputSources = [],
  outputFiles = [],
  workspacePath,
}: {
  sessionId: string;
  repositories: SessionEnvironmentRepository[];
  inputSources?: SessionEnvironmentInputSource[];
  outputFiles?: string[];
  workspacePath?: string;
}) {
  const fileRepositories =
    repositories.length > 0
      ? repositories
      : [
          {
            rootId: "",
            name: "Workspace",
            inputSources,
            outputFiles,
            workspacePath: workspacePath ?? "",
          },
        ];
  const files = fileRepositories.flatMap((repository) => ({
    inputs: (repository.inputSources ?? [])
      .slice(-8)
      .reverse()
      .map((source) => ({
        source,
        rootId: repository.rootId,
        rootName: repository.name,
        workspacePath: repository.workspacePath,
        sessionId,
      })),
    outputs: (repository.outputFiles ?? []).map((path) => ({
      path,
      rootId: repository.rootId,
      rootName: repository.name,
      workspacePath: repository.workspacePath,
      sessionId,
    })),
  }));
  const inputs = files.flatMap((item) => item.inputs);
  const outputs = files.flatMap((item) => item.outputs);

  if (inputs.length === 0 && outputs.length === 0) return null;

  return (
    <WorkspaceFilesCard
      storageKey={`${sessionId}:files`}
      inputCount={inputs.length}
      outputCount={outputs.length}
      inputs={inputs.map(({ source, rootId, rootName, workspacePath }) => (
        <InputSourceRow
          key={`${rootId}:${source.kind}:${source.toolCallId ?? source.assetId ?? source.label}`}
          source={source}
          sessionId={sessionId}
          rootId={rootId}
          rootName={rootName}
          workspacePath={workspacePath}
          onOpen={() =>
            openWorkspaceInputSource(sessionId, source, rootId, rootName)
          }
        />
      ))}
      outputs={
        <OutputFiles
          files={outputs}
          onOpen={({ path, rootId, rootName }) =>
            openWorkspaceFile(sessionId, path, null, rootId, rootName)
          }
        />
      }
    />
  );
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

  const [revertingPaths, setRevertingPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const revertFile = useCallback(
    async (file: SessionEnvironmentFile, rootId?: string) => {
      if (!sessionId) return;
      const confirmMessage = file.untracked
        ? t("workspaceRevertUntrackedConfirm", { file: fileName(file.path) })
        : t("workspaceRevertConfirm", { file: fileName(file.path) });
      if (!window.confirm(confirmMessage)) return;
      const key = `${rootId ?? "primary"}:${file.path}`;
      setRevertingPaths((current) => new Set(current).add(key));
      try {
        await agentRuntimeApi.restoreSessionFile(sessionId, {
          path: file.path,
          ...(rootId ? { rootId } : {}),
        });
        await reload();
      } catch (error) {
        window.alert(
          error instanceof Error && error.message
            ? error.message
            : t("workspaceRevertFailed"),
        );
      } finally {
        setRevertingPaths((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [sessionId, reload, t],
  );

  const changedFiles = repositoryEnvironment?.changedFiles ?? [];
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
      <WorkspaceDashboardLayout
        key={environment.projectId}
        scope={environment.projectId}
      >
        {todos.length > 0 && (
          <DashboardPanel
            id="progress"
            label={locale === "zh" ? "任务进度" : "Progress"}
          >
            <SessionTodoPanel key={sessionId} items={todos} />
          </DashboardPanel>
        )}
        {repositories.map((root) => (
          <DashboardPanel
            key={root.rootId}
            id={`repository:${root.rootId}`}
            label={root.name}
          >
            <RepositoryProjectCard
              key={root.rootId}
              sessionId={sessionId}
              environment={environment}
              repository={root}
              loading={loading}
              reload={reload}
              changedFilesView={changedFilesView}
              onChangedFilesView={setChangedFilesView}
              onRevert={(file, rootId) => void revertFile(file, rootId)}
              revertingPaths={revertingPaths}
            />
          </DashboardPanel>
        ))}
        <DashboardPanel id="files" label={t("workspaceCardFiles")}>
          <WorkspaceFilesDashboardPanel
            sessionId={sessionId}
            repositories={repositories}
            workspacePath={environment.workspacePath}
          />
        </DashboardPanel>
        {subagents.length > 0 && (
          <DashboardPanel id="subagents" label={t("workspaceCardSubagents")}>
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
          </DashboardPanel>
        )}
        <DashboardPanel
          id="processes"
          label={locale === "zh" ? "后台服务" : "Background processes"}
        >
          <SessionBackgroundProcesses
            sessionId={sessionId}
            environment={environment}
          />
        </DashboardPanel>
        <DashboardPanel
          id="runtime"
          label={locale === "zh" ? "运行详情" : "Runtime details"}
        >
          <SessionProfilePanel sessionId={sessionId} />
        </DashboardPanel>
      </WorkspaceDashboardLayout>
    );
  }

  if (!sessionId)
    return <div className="ws-placeholder">{t("workspaceSelectSession")}</div>;

  return (
    <WorkspaceDashboardLayout
      key={environment?.projectId ?? "default"}
      scope={environment?.projectId ?? "default"}
    >
      {todos.length > 0 && (
        <DashboardPanel
          id="progress"
          label={locale === "zh" ? "任务进度" : "Progress"}
        >
          <SessionTodoPanel items={todos} />
        </DashboardPanel>
      )}
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
                    <span className="ws-project-option-top" data-project-color={getProjectThemeColor(root.rootId)}>
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
            <DashboardPanel
              id="repository"
              label={locale === "zh" ? "项目" : "Project"}
            >
              <RepositoryCard
                key={`${sessionId}:${repository?.rootId ?? "primary"}`}
                environment={repositoryEnvironment}
                repository={repository}
                loading={loading}
                reload={reload}
              />
            </DashboardPanel>
          )}
          {(!repository || repository.status === "ready") &&
            changedFiles.length > 0 && (
              <DashboardPanel id="changes" label={t("workspaceCardGitChanges")}>
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
                      onRevert={(file, rootId) => void revertFile(file, rootId)}
                      revertingPaths={revertingPaths}
                      sessionId={sessionId}
                      rootId={repository?.rootId}
                      rootName={repository?.name}
                      workspacePath={repositoryEnvironment?.workspacePath}
                    />
                  ) : (
                    changedFiles.map((file) => (
                      <ChangedFileRow
                        key={`${file.status}:${file.path}`}
                        file={file}
                        onOpen={() => openDiff(file.path)}
                        onRevert={(revertTarget, rootId) => void revertFile(revertTarget, rootId)}
                        reverting={revertingPaths.has(`${repository?.rootId ?? "primary"}:${file.path}`)}
                        sessionId={sessionId}
                        rootId={repository?.rootId}
                        rootName={repository?.name}
                        workspacePath={repositoryEnvironment?.workspacePath}
                      />
                    ))
                  )}
                </WorkspaceCard>
              </DashboardPanel>
            )}

          <DashboardPanel id="files" label={t("workspaceCardFiles")}>
            <WorkspaceFilesDashboardPanel
              sessionId={sessionId}
              repositories={repositories}
              inputSources={environment.inputSources}
              outputFiles={environment.outputFiles}
              workspacePath={environment.workspacePath}
            />
          </DashboardPanel>

          {/* Only meaningful once the session actually spawned subagents — an
              empty placeholder here is pure noise. */}
          {subagents.length > 0 ? (
            <DashboardPanel id="subagents" label={t("workspaceCardSubagents")}>
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
            </DashboardPanel>
          ) : null}
        </>
      ) : loading ? (
        <div className="ws-placeholder">{t("workspaceLoading")}</div>
      ) : null}
      {sessionId && (
        <>
          <DashboardPanel
            id="processes"
            label={locale === "zh" ? "后台服务" : "Background processes"}
          >
            <SessionBackgroundProcesses
              key={sessionId}
              sessionId={sessionId}
              environment={environment}
            />
          </DashboardPanel>
          <DashboardPanel
            id="runtime"
            label={locale === "zh" ? "运行详情" : "Runtime details"}
          >
            <SessionProfilePanel sessionId={sessionId} />
          </DashboardPanel>
        </>
      )}
    </WorkspaceDashboardLayout>
  );
});

interface ChangeRowContext {
  sessionId: string;
  rootId?: string;
  rootName?: string;
  workspacePath?: string;
  onRevert?: (file: SessionEnvironmentFile, rootId?: string) => void;
  revertingPaths?: ReadonlySet<string>;
}

function ChangedFileTree({ directory, onOpen, depth = 0, ...context }: {
  directory: ChangedFileDirectory;
  onOpen: (path: string) => void;
  depth?: number;
} & ChangeRowContext) {
  return (
    <>
      {directory.directories.map((child) => (
        <ChangedFileFolder key={child.path} directory={child} onOpen={onOpen} depth={depth} {...context} />
      ))}
      {directory.files.map((file) => (
        <ChangedFileRow
          key={`${file.status}:${file.path}`}
          file={file}
          depth={depth}
          onOpen={() => onOpen(file.path)}
          reverting={context.revertingPaths?.has(`${context.rootId ?? "primary"}:${file.path}`) ?? false}
          {...context}
        />
      ))}
    </>
  );
}

function ChangedFileFolder({ directory, onOpen, depth, ...context }: {
  directory: ChangedFileDirectory;
  onOpen: (path: string) => void;
  depth: number;
} & ChangeRowContext) {
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
      {expanded && (
        <ChangedFileTree directory={directory} onOpen={onOpen} depth={depth + 1} {...context} />
      )}
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
  const [branchRequest, setBranchRequest] = useState(0);
  const changedCount = environment.changedFiles.length;
  const unavailable = repository && repository.status !== "ready";
  const menu = useContextMenu(() => ({
    label: repository?.name ?? environment.branch,
    entries: [
      { type: "action", id: "refresh", label: t("workspaceRefresh"), disabled: loading, run: () => reload() },
      { type: "action", id: "branch", label: t("contextSwitchBranch"), disabled: Boolean(loading || unavailable), restoreFocus: false, run: () => setBranchRequest((value) => value + 1) },
      { type: "separator" },
      { type: "action", id: "commit", label: t("workspaceCommitPush"), disabled: Boolean(loading || unavailable || changedCount === 0), restoreFocus: false, run: () => setCommitOpen(true) },
    ],
  }));
  return (
    <section
      className={embedded ? "ws-project-repository" : "ws-card ws-card--repo"}
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
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
          openRequest={branchRequest}
          disabled={loading || unavailable}
          onSwitched={() => void reload()}
        />
        {unavailable && (
          <span className="ws-repo-state bg-warning/15 text-warning">
            {t(
              repository.status === "missing"
                ? "workspaceRepositoryMissing"
                : repository.status === "not_repository"
                  ? "workspaceRepositoryNotGit"
                  : "workspaceRepositoryError",
            )}
          </span>
        )}
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
      {commitOpen && (
        <SessionCommitDialog
          isOpen
          sessionId={environment.sessionId}
          projectId={environment.projectId}
          rootId={repository?.rootId}
          rootName={repository?.name}
          branch={environment.branch}
          changedFiles={changedCount}
          onClose={() => setCommitOpen(false)}
          onCommitted={() => void reload()}
        />
      )}
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
    <div className="ws-row ws-row--subagent">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onOpen}
      >
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
      <SubagentControls
        sessionId={sub.id}
        parentSessionId={sub.parentSessionId}
        status={sub.status}
        title={subagentHeadline(sub)}
      />
    </div>
  );
}

function ChangedFileRow({ file, onOpen, depth = 0, onRevert, reverting = false, sessionId, rootId, rootName, workspacePath }: {
  file: SessionEnvironmentFile;
  onOpen: () => void;
  depth?: number;
  reverting?: boolean;
} & Omit<ChangeRowContext, "revertingPaths">) {
  const { t } = useLocale();
  const meta = CHANGE_META[file.status] ?? CHANGE_META.unknown;
  const name = fileName(file.path);
  const hasStats = file.additions > 0 || file.deletions > 0;
  const menu = useContextMenu(() => ({ label: file.path, entries: fileContextEntries({
    t, path: file.path, workspacePath, sessionId, rootId, onDiff: onOpen,
    onOpen: () => openWorkspaceFile(sessionId, file.path, null, rootId, rootName),
    canOpenFile: file.status !== "deleted", canRevert: Boolean(onRevert),
    onRevert: () => onRevert?.(file, rootId), busy: reverting,
  }) }));

  return (
    <div className="ws-row" style={{ paddingLeft: `${6 + depth * 14}px` }} onContextMenu={menu.onContextMenu} onKeyDown={menu.onKeyDown}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" title={file.path} onClick={onOpen} aria-haspopup="menu">
        <FileTypeIcon path={file.path} size={11} />
        <span className={`ws-badge ${meta.tone}`} title={t(meta.labelKey)}>{meta.letter}</span>
        <span className="ws-row-main ws-row-main--file"><span className="ws-row-file">{name}</span></span>
        {hasStats && <span className="ws-row-diff ws-mono">
          {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-danger">-{file.deletions}</span>}
        </span>}
      </button>
      <button type="button" className="ws-icon-button" aria-label={t("contextMoreActions")} aria-haspopup="menu" onClick={(event) => menu.openFromAnchor(event.currentTarget)}>
        <MoreHorizontal size={12} />
      </button>
    </div>
  );
}

function OutputFileRow({ file, onOpen }: {
  file: { path: string; rootId: string; rootName: string; workspacePath: string; sessionId: string };
  onOpen: () => void;
}) {
  const { t } = useLocale();
  const menu = useContextMenu(() => ({ label: file.path, entries: fileContextEntries({
    t, path: file.path, workspacePath: file.workspacePath, sessionId: file.sessionId, rootId: file.rootId, onOpen,
  }) }));
  return <button type="button" className="ws-row" title={file.path} onClick={onOpen} onContextMenu={menu.onContextMenu} onKeyDown={menu.onKeyDown} aria-haspopup="menu">
    <FileTypeIcon path={file.path} size={11} />
    <span className="ws-row-main">
      <span className="ws-row-file">{fileName(file.path)}</span>
      <span className="ws-row-sub">{file.rootName} · {file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : t("workspaceRootDirectory")}</span>
    </span>
  </button>;
}

function OutputFiles({ files, onOpen }: {
  files: Array<{ path: string; rootId: string; rootName: string; workspacePath: string; sessionId: string }>;
  onOpen: (file: { path: string; rootId: string; rootName: string }) => void;
}) {
  return files.map((file) => <OutputFileRow key={`${file.rootId}:${file.path}`} file={file} onOpen={() => onOpen(file)} />);
}

function InputSourceRow({ source, rootName, workspacePath, sessionId, rootId, onOpen }: {
  source: SessionEnvironmentInputSource;
  sessionId: string;
  rootId: string;
  rootName: string;
  workspacePath: string;
  onOpen: () => void;
}) {
  const { t } = useLocale();
  const label = source.path ? fileName(source.path) : source.label;
  const menu = useContextMenu(() => ({ label: source.label, entries: sourceContextEntries({
    t, label: source.label, path: source.kind === "file" ? source.path : undefined,
    workspacePath: source.kind === "file" ? workspacePath : undefined, sessionId, rootId, onOpen,
  }) }));
  return <button type="button" className="ws-row" title={source.label} onClick={onOpen} onContextMenu={menu.onContextMenu} onKeyDown={menu.onKeyDown} aria-haspopup="menu">
    <FileTypeIcon path={source.path ?? source.label} size={11} />
    <span className="ws-row-main ws-row-main--file"><span className="ws-row-file">{label}</span><span className="ws-row-sub">{rootName} · {source.kind}</span></span>
  </button>;
}
