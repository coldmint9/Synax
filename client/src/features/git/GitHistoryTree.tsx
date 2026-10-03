import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowDown,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  MoreHorizontal,
  Search,
  X,
} from "lucide-react";
import type {
  GitCommitSummary,
  GitWorkspaceSummary,
} from "../../adapters/transport/project";
import { projectApi, type GitCommitDetail } from "../../adapters/transport/project";
import {
  GitHistoryActionDialog,
  HistoryContextTarget,
  type HistoryActionSelection,
} from "./GitHistoryActions";
import type { GitActionResult } from "../../../../services/local-node/modules/git-history-contracts";
import type { GitAssociations } from "../../../../services/local-node/modules/git-epic-contracts";
import { GitEpicPanel, BranchSessionsDialog } from "./GitEpics";
import { MergeFileViewer } from "../../shared/ui/file-viewer/MergeFileViewer";
import { Button } from "../../shared/ui/ui/Button";
import { GitHistoryRefs } from "./GitHistoryRefs";
import { GitCommitInspector } from "./GitCommitInspector";
import type { MergeFile } from "../../../../services/local-node/modules/git-mr/contracts";

type HistoryFilter = "all" | "merge" | "workspace";
const LANE_WIDTH = 22;
const ROW_HEIGHT = 60;
const MIN_RAIL_WIDTH = 54;

type TopologyConnection = { from: number; to: number; merge: boolean };
type TopologyRow = { nodeLane: number; connections: TopologyConnection[] };

export function buildTopology(commits: GitCommitSummary[]) {
  let active: string[] = [];
  const rows: TopologyRow[] = [];

  commits.forEach((commit) => {
    const before = [...active];
    const existingLane = before.indexOf(commit.id);
    const nodeLane = existingLane >= 0 ? existingLane : before.length;
    const parents = commit.parents;
    const after = before.slice();
    after.splice(nodeLane, 1, ...parents);
    const uniqueAfter = [...new Set(after)];
    const connections: TopologyConnection[] = [];

    before.forEach((laneId, from) => {
      if (laneId === commit.id) return;
      const to = uniqueAfter.indexOf(laneId);
      if (to >= 0) connections.push({ from, to, merge: false });
    });
    parents.forEach((parent) => {
      const to = uniqueAfter.indexOf(parent);
      if (to >= 0)
        connections.push({ from: nodeLane, to, merge: parents.length > 1 });
    });

    active = uniqueAfter;
    rows.push({ nodeLane, connections });
  });
  return rows;
}

function laneX(lane: number) {
  return 16 + lane * LANE_WIDTH;
}

function topologyPath(from: number, to: number, row: number) {
  const fromX = laneX(from);
  const toX = laneX(to);
  const fromY = row * ROW_HEIGHT + ROW_HEIGHT / 2;
  const toY = (row + 1) * ROW_HEIGHT + ROW_HEIGHT / 2;
  if (fromX === toX) return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  return `M ${fromX} ${fromY} C ${fromX} ${fromY + 15}, ${toX} ${toY - 15}, ${toX} ${toY}`;
}

function shortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function GitHistoryTree({
  workspace,
  projectId,
  rootId,
}: {
  workspace: GitWorkspaceSummary;
  projectId?: string;
  rootId?: string;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pages, setPages] = useState<GitCommitSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const nextOffsetRef = useRef<number | null>(0);
  const snapshot = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailRetry, setDetailRetry] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectionTrigger = useRef<HTMLElement | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const openCommit = (id: string) => {
    selectionTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setSelectedId(id);
  };
  const closeCommit = useCallback(() => {
    setSelectedId(null);
    if (selectionTrigger.current?.isConnected)
      selectionTrigger.current.focus({ preventScroll: true });
    else searchRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !target.closest(
          "input, textarea, select, [contenteditable]:not([contenteditable=false])",
        ) &&
        !document.querySelector(
          '[role="dialog"], [role="menu"], [data-slot="popover"]',
        )
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);
  const [action, setAction] = useState<HistoryActionSelection | null>(null);
  const [actionResult, setActionResult] = useState<GitActionResult | null>(
    null,
  );
  const [associations, setAssociations] = useState<GitAssociations | null>(
    null,
  );
  const [associationError, setAssociationError] = useState("");
  const [branchSessions, setBranchSessions] = useState<string | null>(null);
  const [conflictFile, setConflictFile] = useState<MergeFile | null>(null);
  const [conflictError, setConflictError] = useState("");
  const refreshState = () => {
    if (projectId)
      void projectApi
        .gitState(projectId, rootId)
        .then(setActionResult)
        .catch((err) => setConflictError(String(err.message ?? err)));
  };
  useEffect(() => {
    setActionResult(null);
    setConflictFile(null);
    setConflictError("");
    refreshState();
    window.addEventListener("focus", refreshState);
    return () => window.removeEventListener("focus", refreshState);
  }, [projectId, rootId, workspace]);
  const openConflict = async (path: string) => {
    if (!projectId) return;
    setConflictError("");
    try {
      setConflictFile(await projectApi.gitConflict(projectId, path, rootId));
    } catch (err) {
      setConflictError(String(err instanceof Error ? err.message : err));
    }
  };
  const refreshAssociations = () => {
    if (!projectId) return;
    void projectApi
      .gitAssociations(projectId, rootId)
      .then((value) => {
        setAssociations(value);
        setAssociationError("");
      })
      .catch((err) => setAssociationError(String(err.message ?? err)));
  };
  useEffect(() => {
    setAssociations(null);
    refreshAssociations();
    window.addEventListener("focus", refreshAssociations);
    return () => window.removeEventListener("focus", refreshAssociations);
  }, [projectId, rootId, workspace]);
  const activeWorktree =
    workspace.worktrees.find((item) => item.path === workspace.defaultPath) ??
    workspace.worktrees.find((item) => item.primary);
  const actionHead = actionResult?.head ?? activeWorktree?.head ?? "";
  const commits = projectId ? pages : (workspace.commits ?? []);
  const loadPage = async (offset: number, reset = false) => {
    if (!projectId) return;
    if (reset) {
      generation.current++;
      inFlight.current = false;
      snapshot.current = undefined;
      nextOffsetRef.current = 0;
    }
    if (inFlight.current || offset !== nextOffsetRef.current) return;
    const version = generation.current;
    inFlight.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await projectApi.gitHistory(projectId, {
        rootId,
        offset,
        snapshot: snapshot.current,
      });
      if (version !== generation.current) return;
      snapshot.current = page.snapshot;
      setPages((current) => [
        ...new Map(
          (offset === 0 ? page.commits : [...current, ...page.commits]).map(
            (commit) => [commit.id, commit],
          ),
        ).values(),
      ]);
      nextOffsetRef.current = page.nextOffset;
      setNextOffset(page.nextOffset);
    } catch (err) {
      if (version === generation.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (version === generation.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  };
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    snapshot.current = undefined;
    nextOffsetRef.current = 0;
    setPages([]);
    setNextOffset(0);
    setSelectedId(null);
    void loadPage(0);
    return () => {
      generation.current++;
    };
  }, [projectId, rootId, workspace]);
  useEffect(() => {
    let active = true;
    setDetail(null);
    setDetailError("");
    if (projectId && selectedId)
      void projectApi
        .gitCommit(projectId, selectedId, rootId)
        .then((value) => {
          if (active) setDetail(value);
        })
        .catch((err) => {
          if (active) setDetailError(String(err.message ?? err));
        });
    return () => {
      active = false;
    };
  }, [projectId, rootId, selectedId, detailRetry]);
  const currentHeads = useMemo(
    () =>
      new Set(
        workspace.worktrees
          .filter((item) => item.primary)
          .map((item) => item.head),
      ),
    [workspace.worktrees],
  );
  const dirtyHeads = useMemo(
    () =>
      new Set(
        workspace.worktrees
          .filter((item) => item.dirty)
          .map((item) => item.head),
      ),
    [workspace.worktrees],
  );
  const filteredCommits = useMemo(
    () =>
      commits.filter((commit) => {
        const textMatch =
          `${commit.subject} ${commit.author} ${commit.id} ${commit.refs.join(" ")}`
            .toLowerCase()
            .includes(query.trim().toLowerCase());
        const filterMatch =
          filter === "all" ||
          (filter === "merge" && commit.parents.length > 1) ||
          (filter === "workspace" &&
            (currentHeads.has(commit.id) || dirtyHeads.has(commit.id)));
        return textMatch && filterMatch;
      }),
    [commits, query, filter, currentHeads, dirtyHeads],
  );
  const topology = useMemo(() => {
    if (!query.trim() && filter === "all")
      return buildTopology(filteredCommits);
    const visible = new Set(filteredCommits.map((commit) => commit.id));
    return buildTopology(
      filteredCommits.map((commit) => ({
        ...commit,
        parents: commit.parents.filter((parent) => visible.has(parent)),
      })),
    );
  }, [filteredCommits, query, filter]);
  const railWidth = topology.reduce(
    (width, row) =>
      Math.max(
        width,
        laneX(row.nodeLane) + 22,
        ...row.connections.map(
          (edge) => laneX(Math.max(edge.from, edge.to)) + 22,
        ),
      ),
    MIN_RAIL_WIDTH,
  );
  const selected = commits.find((commit) => commit.id === selectedId);
  const graphHeight = filteredCommits.length * ROW_HEIGHT;

  const selectedIndex = filteredCommits.findIndex(
    (commit) => commit.id === selectedId,
  );
  const hasFilter = Boolean(query.trim()) || filter !== "all";
  const openSessions = projectId
    ? (ref: string) => {
        setBranchSessions(ref);
        refreshAssociations();
      }
    : undefined;
  const resetFilters = () => {
    setQuery("");
    setFilter("all");
    searchRef.current?.focus();
  };
  const renderedRefs = (refs: string[], expanded = false) => (
    <GitHistoryRefs
      refs={refs}
      expanded={expanded}
      associations={associations}
      onAction={setAction}
      onOpenSessions={openSessions}
    />
  );

  return (
    <div className="history-tree flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className={`git-history-layout min-h-0 flex-1 ${selected ? "has-inspector" : ""}`}
      >
        <section
          className="git-history-island flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[20px] border border-[var(--ui-line)] bg-[var(--ui-panel)]"
          aria-label="提交历史工作区"
        >
          <header className="history-tree-toolbar flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--ui-line)] p-4 sm:px-5">
            <div className="history-tree-search flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl bg-[var(--ui-panel-soft)] px-3 text-[var(--ui-subtle)] focus-within:ring-2 focus-within:ring-[var(--ui-accent)]">
              <Search size={15} aria-hidden="true" className="shrink-0" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (viewportRef.current) viewportRef.current.scrollTop = 0;
                }}
                className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-[var(--ui-text)] outline-none placeholder:text-[var(--ui-subtle)]"
                placeholder="搜索提交、分支或作者"
                aria-label="搜索提交、分支或作者"
                aria-describedby="history-search-scope"
              />
              {query ? (
                <button
                  className="git-control grid size-7 shrink-0 place-items-center rounded-md hover:bg-[var(--ui-panel)]"
                  aria-label="清除搜索"
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                >
                  <X size={14} />
                </button>
              ) : (
                <kbd
                  className="hidden rounded border border-[var(--ui-line)] px-1.5 text-[11px] sm:block"
                  aria-hidden="true"
                >
                  /
                </kbd>
              )}
            </div>
            <div
              className="history-tree-filters flex h-10 shrink-0 items-center gap-1 rounded-xl bg-[var(--ui-panel-soft)] p-1"
              role="group"
              aria-label="提交筛选"
            >
              {(
                [
                  ["all", "全部"],
                  ["merge", "合并提交"],
                  ["workspace", "工作区"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`git-control h-8 rounded-lg px-3 text-xs transition-colors motion-reduce:transition-none ${filter === id ? "bg-[var(--ui-panel)] font-medium text-[var(--ui-text)] shadow-[0_1px_3px_rgb(0_0_0/0.06)]" : "text-[var(--ui-subtle)] hover:text-[var(--ui-text)]"}`}
                  aria-pressed={filter === id}
                  onClick={() => {
                    setFilter(id);
                    if (viewportRef.current) viewportRef.current.scrollTop = 0;
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {projectId && (
              <Button
                className="git-control history-fetch !h-10 !rounded-xl"
                variant="outline"
                onClick={() => setAction({ action: "fetch" })}
              >
                <ArrowDown size={14} aria-hidden="true" />
                Fetch
              </Button>
            )}
          </header>
          <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2 text-[11px] text-[var(--ui-subtle)]">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <GitBranch size={12} aria-hidden="true" />
              <span
                className="max-w-60 truncate"
                title={
                  actionResult?.branch ?? activeWorktree?.branch ?? undefined
                }
              >
                {actionResult?.branch ?? activeWorktree?.branch ?? "提交历史"}
              </span>
              {activeWorktree?.dirty && (
                <span className="git-dirty-label ml-1 inline-flex items-center gap-1">
                  <span className="size-1.5 rounded-full bg-current" />
                  未提交
                </span>
              )}
            </span>
            <span className="ml-auto tabular-nums" role="status">
              {loading && !commits.length
                ? "正在读取历史…"
                : hasFilter
                  ? `${filteredCommits.length} / ${commits.length} 条提交`
                  : `已加载 ${commits.length} 条提交`}
            </span>
          </div>
          {actionResult && (actionResult.output || actionResult.operation) && (
            <div
              role="status"
              className="git-operation-banner mx-5 mb-3 rounded-xl bg-[var(--ui-canvas)] p-3 text-xs"
            >
              {actionResult.output && (
                <pre className="max-h-24 overflow-auto whitespace-pre-wrap">
                  {actionResult.output}
                </pre>
              )}
              {actionResult.operation && (
                <>
                  <p>
                    {actionResult.operation} 进行中 ·{" "}
                    {actionResult.conflicts.length} 个冲突文件
                  </p>
                  <ul>
                    {actionResult.conflicts.map((path) => (
                      <li key={path}>
                        <button onClick={() => void openConflict(path)}>
                          {path} · 解决冲突
                        </button>
                      </li>
                    ))}
                  </ul>
                  <Button
                    className="git-control"
                    size="sm"
                    disabled={actionResult.conflicts.length > 0}
                    onClick={() => setAction({ action: "continue" })}
                  >
                    继续操作
                  </Button>
                  <Button
                    className="git-control ml-2"
                    size="sm"
                    onClick={() => setAction({ action: "abort" })}
                  >
                    中止操作
                  </Button>
                </>
              )}
            </div>
          )}
          {conflictError && (
            <p role="alert" className="px-5 text-xs">
              {conflictError}{" "}
              <button onClick={refreshState}>刷新操作状态</button>
            </p>
          )}
          <div
            ref={viewportRef}
            className="history-tree-viewport min-h-0 flex-1 overflow-auto overscroll-contain"
            onScroll={(event) => {
              const el = event.currentTarget;
              if (
                !hasFilter &&
                !error &&
                nextOffset !== null &&
                el.scrollTop + el.clientHeight >= el.scrollHeight - 120
              )
                void loadPage(nextOffset);
            }}
          >
            <div
              className="history-tree-table-wrap"
              style={
                {
                  "--history-rail-width": `${railWidth}px`,
                  "--history-row-height": `${ROW_HEIGHT}px`,
                } as CSSProperties
              }
            >
              {filteredCommits.length > 0 && (
                <svg
                  className="history-tree-rail"
                  width={railWidth}
                  height={graphHeight}
                  viewBox={`0 0 ${railWidth} ${graphHeight}`}
                  aria-hidden="true"
                  preserveAspectRatio="none"
                >
                  {topology.flatMap((row, index) =>
                    row.connections.map((connection, connectionIndex) => (
                      <path
                        key={`${index}-${connectionIndex}`}
                        d={topologyPath(connection.from, connection.to, index)}
                        className={
                          connection.merge
                            ? "is-merge"
                            : connection.from === 0
                              ? "is-main"
                              : "is-branch"
                        }
                      />
                    )),
                  )}
                  {filteredCommits.map((commit, index) => (
                    <circle
                      key={commit.id}
                      cx={laneX(topology[index]?.nodeLane ?? 0)}
                      cy={index * ROW_HEIGHT + ROW_HEIGHT / 2}
                      r={commit.parents.length > 1 ? 5 : 3.5}
                      className={
                        currentHeads.has(commit.id)
                          ? "is-current"
                          : commit.parents.length > 1
                            ? "is-merge"
                            : ""
                      }
                    />
                  ))}
                </svg>
              )}
              <table
                aria-label="Git 提交历史"
                className="history-tree-content w-full table-fixed border-collapse text-left text-xs"
              >
                <thead>
                  <tr>
                    <th scope="col">提交标题</th>
                    <th scope="col">分支标签</th>
                    <th scope="col">Commit ID</th>
                    <th scope="col">作者</th>
                    <th scope="col">时间</th>
                    <th scope="col">
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCommits.map((commit) => {
                    const isCurrent = currentHeads.has(commit.id);
                    const isMerge = commit.parents.length > 1;
                    const isDirty = dirtyHeads.has(commit.id);
                    return (
                      <HistoryContextTarget
                        key={commit.id}
                        row
                        target={commit.id}
                        selected={selectedId === commit.id}
                        onSelect={() => openCommit(commit.id)}
                        onAction={setAction}
                      >
                        <td>
                          <button
                            type="button"
                            className="git-control history-table-title-button flex h-full w-full min-w-0 flex-col justify-center gap-1 text-left"
                            title={commit.subject || "无提交说明"}
                            aria-label={commit.subject || "无提交说明"}
                            onClick={() => openCommit(commit.id)}
                          >
                            <strong className="block w-full truncate text-[13px] font-medium">
                              {commit.subject || "无提交说明"}
                            </strong>
                            <span className="flex w-full items-center gap-2 overflow-hidden text-[10px] text-[var(--ui-subtle)]">
                              <span className="inline-flex shrink-0 items-center gap-1">
                                {isMerge ? (
                                  <GitMerge size={11} aria-hidden="true" />
                                ) : (
                                  <GitCommitHorizontal
                                    size={11}
                                    aria-hidden="true"
                                  />
                                )}
                                {isMerge
                                  ? "合并提交"
                                  : commit.rebase
                                    ? "Rebase"
                                    : "提交"}
                              </span>
                              {isCurrent && (
                                <span className="git-head-label">HEAD</span>
                              )}
                              {isDirty && (
                                <span
                                  className="git-dirty-label inline-flex shrink-0 items-center gap-1"
                                  aria-label="有未提交更改"
                                >
                                  <span
                                    className="size-1 rounded-full bg-current"
                                    aria-hidden="true"
                                  />
                                  未提交
                                </span>
                              )}
                              <span className="history-mobile-meta truncate">
                                {commit.author} · {shortDate(commit.authoredAt)}
                              </span>
                            </span>
                          </button>
                        </td>
                        <td>{renderedRefs(commit.refs)}</td>
                        <td>
                          <code
                            className="text-[11px] text-[var(--ui-subtle)]"
                            title={commit.id}
                          >
                            {commit.id.slice(0, 8)}
                          </code>
                        </td>
                        <td>
                          <span
                            className="block truncate text-[11px] text-[var(--ui-subtle)]"
                            title={commit.author}
                          >
                            {commit.author}
                          </span>
                        </td>
                        <td>
                          <time
                            className="whitespace-nowrap text-[11px] text-[var(--ui-subtle)]"
                            dateTime={commit.authoredAt}
                            title={new Date(commit.authoredAt).toLocaleString(
                              "zh-CN",
                            )}
                          >
                            {shortDate(commit.authoredAt)}
                          </time>
                        </td>
                        <td>
                          <HistoryContextTarget
                            target={commit.id}
                            label={`提交操作：${commit.subject || commit.id}`}
                            onSelect={() => openCommit(commit.id)}
                            onAction={setAction}
                          >
                            <MoreHorizontal size={16} aria-hidden="true" />
                          </HistoryContextTarget>
                        </td>
                      </HistoryContextTarget>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!filteredCommits.length && (
              <div className="history-tree-empty flex min-h-64 flex-col items-center justify-center gap-3 px-6 text-center text-[var(--ui-subtle)]">
                {loading ? (
                  <Loader2
                    size={24}
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <GitCommitHorizontal
                    size={28}
                    strokeWidth={1.3}
                    aria-hidden="true"
                  />
                )}
                <strong className="text-sm font-medium text-[var(--ui-text)]">
                  {loading
                    ? "正在加载提交历史…"
                    : error
                      ? "暂时无法读取历史"
                      : hasFilter
                        ? "没有匹配的提交"
                        : "还没有提交记录"}
                </strong>
                <span className="text-xs">
                  {hasFilter
                    ? "搜索与筛选作用于已加载的提交。"
                    : loading
                      ? "正在整理分支与提交关系"
                      : "提交记录会在这里按历史顺序显示。"}
                </span>
                {hasFilter && (
                  <Button
                    className="git-control"
                    variant="outline"
                    size="sm"
                    onClick={resetFilters}
                  >
                    清除筛选
                  </Button>
                )}
              </div>
            )}
          </div>
          {error && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 border-t border-[var(--ui-line)] px-5 py-3 text-xs"
            >
              <span>{error}</span>
              <Button
                className="git-control"
                size="sm"
                onClick={() => void loadPage(0, true)}
              >
                刷新历史
              </Button>
            </div>
          )}
          <footer className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 border-t border-[var(--ui-line)] px-5 py-2 text-[11px] text-[var(--ui-subtle)]">
            <span id="history-search-scope">
              {hasFilter
                ? "正在筛选已加载的提交"
                : "点击查看详情 · 右键更多操作"}
            </span>
            <div className="ml-auto flex items-center gap-3">
              {projectId && associations && (
                <GitEpicPanel
                  projectId={projectId}
                  rootId={rootId}
                  data={associations}
                  onRefresh={refreshAssociations}
                />
              )}
              {projectId && nextOffset !== null ? (
                <Button
                  className="git-control"
                  variant="ghost"
                  size="sm"
                  disabled={loading}
                  onClick={() => void loadPage(nextOffset)}
                >
                  {loading ? "加载中…" : error ? "重试" : "加载更多提交"}
                  {!loading && <ArrowDown size={12} aria-hidden="true" />}
                </Button>
              ) : (
                <span>已显示全部提交</span>
              )}
            </div>
          </footer>
        </section>
        {selected && (
          <GitCommitInspector
            commit={selected}
            detail={detail?.id === selected.id ? detail : null}
            error={detailError}
            loading={Boolean(projectId && !detail && !detailError)}
            refs={renderedRefs(selected.refs, true)}
            onClose={closeCommit}
            onRetry={() => setDetailRetry((value) => value + 1)}
            onPrevious={
              selectedIndex > 0
                ? () => setSelectedId(filteredCommits[selectedIndex - 1].id)
                : undefined
            }
            onNext={
              selectedIndex >= 0 && selectedIndex < filteredCommits.length - 1
                ? () => setSelectedId(filteredCommits[selectedIndex + 1].id)
                : undefined
            }
          />
        )}
      </div>
      {associationError && (
        <p role="alert">
          {associationError}{" "}
          <button onClick={refreshAssociations}>重试会话索引</button>
        </p>
      )}
      {projectId && action && (
        <GitHistoryActionDialog
          projectId={projectId}
          rootId={rootId}
          head={actionHead}
          worktree={workspace.defaultPath}
          selection={action}
          onClose={() => setAction(null)}
          onDone={(result) => {
            setActionResult(result);
            refreshAssociations();
            void loadPage(0, true);
          }}
        />
      )}
      {projectId && associations && branchSessions && (
        <BranchSessionsDialog
          projectId={projectId}
          branch={branchSessions}
          data={associations}
          onClose={() => setBranchSessions(null)}
        />
      )}
      {projectId && conflictFile && (
        <MergeFileViewer
          key={conflictFile.id}
          file={conflictFile}
          onClose={() => {
            setConflictFile(null);
            refreshState();
          }}
          onSave={async (input) => {
            const saved = await projectApi.saveGitConflict(
              projectId,
              conflictFile.path,
              input,
              rootId,
            );
            setConflictFile(saved);
            refreshState();
          }}
        />
      )}
    </div>
  );
}
