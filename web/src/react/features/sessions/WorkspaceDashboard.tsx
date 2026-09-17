import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Bot,
  Check,
  ChevronDown,
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
  SessionEnvironmentRepository,
  SessionEnvironmentSubagent,
} from "../../../lib/api/agentRuntime";
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
import { SessionCommitDialog } from "./SessionCommitDialog";
import { useSessionEnvironment } from "./useSessionEnvironment";

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
function buildChangedFileTree(files: SessionEnvironmentFile[]): ChangedFileDirectory {
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
    directory.files.sort((a, b) => fileName(a.path).localeCompare(fileName(b.path)));
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
  const { t } = useLocale();
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
  const [changedFilesView, setChangedFilesView] = useState<"tree" | "flat">("tree");
  const selectedRootId = useSessionWorkspaceStore(state => sessionId ? state.sessions[sessionId]?.selectedRootId : undefined);
  const selectRepository = useSessionWorkspaceStore(state => state.selectRepository);
  const repositories = environment?.repositories ?? [];
  const repository = repositories.find(root => root.rootId === selectedRootId)
    ?? repositories.find(root => root.role === "primary")
    ?? repositories[0];
  const repositoryEnvironment = environment && repository ? { ...environment, ...repository } : environment;
  const openDiff = (filePath: string) => {
    if (!sessionId) return;
    if (repository) openWorkspaceDiff(sessionId, filePath, repository.rootId, repository.name);
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

  const recentFiles = useMemo(
    () => (repositoryEnvironment?.inputFiles ?? []).slice(-8).reverse(),
    [repositoryEnvironment?.inputFiles],
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

  return (
    <div className="workspace-dashboard session-workspace-scroll min-h-0 flex-1 overflow-y-auto">
      {sessionId && (
        <SessionBackgroundProcesses key={sessionId} sessionId={sessionId} />
      )}
      {!sessionId ? (
        <div className="ws-placeholder">{t("workspaceSelectSession")}</div>
      ) : environment && repositoryEnvironment ? (
        <>
          {repositories.length > 1 && (
            <section className="ws-project-switcher" aria-label={c.members}>
              <div className="workspace-section-label"><span className="flex items-center gap-1.5"><Layers2 size={12} />{c.members}</span><span className="workspace-count">{repositories.length}</span></div>
              <div className="ws-project-options" role="group" aria-label={t("workspaceRepositorySelect")}>
                {repositories.map(root => (
                  <button key={root.rootId} type="button" className="ws-project-option"
                    aria-pressed={repository?.rootId === root.rootId}
                    aria-label={root.name}
                    onClick={() => selectRepository(sessionId, root.rootId)}>
                    <span className="ws-project-option-top"><Folder size={13} /><strong title={root.name}>{root.name}</strong>{root.role === "primary" && <Pin size={10} aria-label={c.primary} />}
                      <span className="ws-project-change-count" data-dirty={root.changedFiles.length > 0 || undefined}>{root.status === "ready" ? root.changedFiles.length || <Check size={10} /> : "!"}</span>
                    </span>
                    <span className="ws-project-option-meta">{root.status === "ready" ? <><GitBranch size={10} /><span>{root.branch}</span></> : <span className="text-warning">{t(root.status === "missing" ? "workspaceRepositoryMissing" : root.status === "not_repository" ? "workspaceRepositoryNotGit" : "workspaceRepositoryError")}</span>}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <RepositoryCard
            key={`${sessionId}:${repository?.rootId ?? "primary"}`}
            environment={repositoryEnvironment}
            repository={repository}
            loading={loading}
            reload={reload}
          />

          {/* Only meaningful once the session actually spawned subagents — an
              empty placeholder here is pure noise. */}
          {subagents.length > 0 ? (
            <WorkspaceCard
              icon={<Bot size={11} />}
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

          {(!repository || repository.status === "ready") && <WorkspaceCard
            icon={<FileDiff size={11} />}
            title={t("workspaceCardGitChanges")}
            count={changedFiles.length}
            actions={(
              <div className="ws-view-toggle" role="group" aria-label={t("workspaceChangeView")}>
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
            )}
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
          </WorkspaceCard>}

          <WorkspaceCard
            icon={<FileCode2 size={11} />}
            title={t("workspaceCardInputFiles")}
            count={recentFiles.length}
          >
            {recentFiles.length === 0 ? (
              <div className="ws-empty">{t("workspaceNoInputFiles")}</div>
            ) : (
              recentFiles.map((path) => (
                <InputFileRow
                  key={path}
                  path={path}
                  copied={copiedPath === path}
                  onOpen={() => repository
                    ? openWorkspaceFile(sessionId, path, null, repository.rootId, repository.name)
                    : openWorkspaceFile(sessionId, path)}
                  onCopy={() => void copyPath(path)}
                />
              ))
            )}
          </WorkspaceCard>
        </>
      ) : loading ? (
        <div className="ws-placeholder">{t("workspaceLoading")}</div>
      ) : null}
    </div>
  );
});

/** Collapsible card: header stays visible, the list scrolls inside the body. */
function WorkspaceCard({
  icon,
  title,
  count,
  summary,
  actions,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  summary?: string | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(true);

  return (
    <section className="ws-card" data-open={open ? "true" : "false"}>
      <div className="ws-card-head">
        <button
          type="button"
          className="ws-card-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="ws-card-icon">{icon}</span>
          <span className="ws-card-title">{title}</span>
          <span className="ws-card-count">{count}</span>
        </button>
        <span className="ws-card-tail">
          {summary ? <span className="ws-card-summary">{summary}</span> : null}
          {actions}
          <button
            type="button"
            className="ws-card-collapse"
            aria-label={open ? t("sessionCollapse") : t("sessionExpand")}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDown size={11} className="ws-card-chevron" />
          </button>
        </span>
      </div>
      {open ? <div className="ws-card-body">{children}</div> : null}
    </section>
  );
}

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
      {directory.directories.map(child => (
        <ChangedFileFolder
          key={child.path}
          directory={child}
          onOpen={onOpen}
          depth={depth}
        />
      ))}
      {directory.files.map(file => (
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
        onClick={() => setExpanded(value => !value)}
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
}: {
  environment: SessionEnvironment;
  repository?: SessionEnvironmentRepository;
  loading: boolean;
  reload: () => void | Promise<void>;
}) {
  const { t } = useLocale();
  const [commitOpen, setCommitOpen] = useState(false);
  const changedCount = environment.changedFiles.length;
  const unavailable = repository && repository.status !== "ready";
  return (
    <section className="ws-card ws-card--repo">
      {repository && <div className="ws-repo-project"><Folder size={12} /><strong>{repository.name}</strong></div>}
      <div className="ws-repo-head">
        <GitBranch size={11} className="ws-repo-icon" />
        <span className="ws-repo-branch" title={environment.branch}>
          {environment.branch}
        </span>
        <span
          className={`ws-repo-state ${unavailable ? "bg-warning/15 text-warning" : environment.dirty ? "bg-warning/15 text-warning" : "bg-success/15 text-success"}`}
        >
          {unavailable
            ? t(repository.status === "missing" ? "workspaceRepositoryMissing" : repository.status === "not_repository" ? "workspaceRepositoryNotGit" : "workspaceRepositoryError")
            : environment.dirty ? "dirty" : "clean"}
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
      {!unavailable && <div className="ws-repo-meta">
        <span className="ws-repo-meta-item">
          <GitCommit size={10} />
          <span className="ws-mono">
            {environment.headCommitSha.slice(0, 8)}
          </span>
        </span>
        <span className="ws-repo-meta-item ws-mono">
          <span className="text-success">+{environment.additions}</span>
          <span className="ws-repo-sep">/</span>
          <span className="text-danger">-{environment.deletions}</span>
        </span>
      </div>}
      {environment.workspacePath ? (
        <div className="ws-repo-path" title={environment.workspacePath}>
          {environment.workspacePath}
        </div>
      ) : null}
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

function InputFileRow({
  path,
  copied,
  onOpen,
  onCopy,
}: {
  path: string;
  copied: boolean;
  onOpen: () => void;
  onCopy: () => void;
}) {
  const name = fileName(path);

  return (
    <button
      type="button"
      className="ws-row"
      title={path}
      onClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault();
        onCopy();
      }}
    >
      <FileTypeIcon path={path} size={11} />
      <span className="ws-row-main ws-row-main--file">
        <span className="ws-row-file">{name}</span>
      </span>
      {copied ? <Check size={11} className="ws-row-icon text-success" /> : null}
    </button>
  );
}
