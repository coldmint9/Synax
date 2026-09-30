import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, GitCommitHorizontal, GitMerge, Search } from "lucide-react";
import type { GitCommitSummary, GitWorkspaceSummary } from "../../../lib/api/project";
import { projectApi, type GitCommitDetail } from "../../../lib/api/project";
import { GitHistoryActionDialog, HistoryContextTarget, type HistoryActionSelection } from "./GitHistoryActions";
import type { GitActionResult } from "../../../../../api/services/git-history-contracts";
import type { GitAssociations } from "../../../../../api/services/git-epic-contracts";
import { GitEpicPanel, BranchSessionsDialog } from "./GitEpics";
import { MergeFileViewer } from "../../components/file-viewer/MergeFileViewer";
import type { MergeFile } from "../../../../../api/services/git-mr/contracts";

type HistoryFilter = "all" | "merge" | "workspace";
const LANE_WIDTH = 22;
const ROW_HEIGHT = 32;
const MIN_RAIL_WIDTH = 54;

type TopologyConnection = { from: number; to: number; merge: boolean };
type TopologyRow = { nodeLane: number; connections: TopologyConnection[] };

export function buildTopology(
  commits: GitCommitSummary[],
) {
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
      if (to >= 0) connections.push({ from: nodeLane, to, merge: parents.length > 1 });
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
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export default function GitHistoryTree({ workspace, projectId, rootId }: { workspace: GitWorkspaceSummary; projectId?: string; rootId?: string }) {
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
  const [action, setAction] = useState<HistoryActionSelection | null>(null);
  const [actionResult, setActionResult] = useState<GitActionResult | null>(null);
  const [associations, setAssociations] = useState<GitAssociations | null>(null);
  const [associationError, setAssociationError] = useState("");
  const [branchSessions, setBranchSessions] = useState<string | null>(null);
  const [conflictFile, setConflictFile] = useState<MergeFile | null>(null);
  const [conflictError, setConflictError] = useState("");
  const refreshState = () => {
    if (projectId) void projectApi.gitState(projectId, rootId).then(setActionResult).catch(err => setConflictError(String(err.message ?? err)));
  };
  useEffect(() => {
    setActionResult(null); setConflictFile(null); setConflictError(""); refreshState();
    window.addEventListener("focus", refreshState);
    return () => window.removeEventListener("focus", refreshState);
  }, [projectId, rootId, workspace]);
  const openConflict = async (path: string) => {
    if (!projectId) return;
    setConflictError("");
    try { setConflictFile(await projectApi.gitConflict(projectId, path, rootId)); }
    catch (err) { setConflictError(String(err instanceof Error ? err.message : err)); }
  };
  const refreshAssociations = () => {
    if (!projectId) return;
    void projectApi.gitAssociations(projectId, rootId).then(value => { setAssociations(value); setAssociationError(""); }).catch(err => setAssociationError(String(err.message ?? err)));
  };
  useEffect(() => {
    setAssociations(null); refreshAssociations();
    window.addEventListener("focus", refreshAssociations);
    return () => window.removeEventListener("focus", refreshAssociations);
  }, [projectId, rootId, workspace]);
  const activeWorktree = workspace.worktrees.find(item => item.path === workspace.defaultPath) ?? workspace.worktrees.find(item => item.primary);
  const actionHead = actionResult?.head ?? activeWorktree?.head ?? "";
  const commits = projectId ? pages : workspace.commits ?? [];
  const loadPage = async (offset: number, reset = false) => {
    if (!projectId) return;
    if (reset) { generation.current++; inFlight.current = false; snapshot.current = undefined; nextOffsetRef.current = 0; }
    if (inFlight.current || offset !== nextOffsetRef.current) return;
    const version = generation.current;
    inFlight.current = true; setLoading(true); setError("");
    try {
      const page = await projectApi.gitHistory(projectId, { rootId, offset, snapshot: snapshot.current });
      if (version !== generation.current) return;
      snapshot.current = page.snapshot;
      setPages(current => [...new Map((offset === 0 ? page.commits : [...current, ...page.commits]).map(commit => [commit.id, commit])).values()]);
      nextOffsetRef.current = page.nextOffset;
      setNextOffset(page.nextOffset);
    } catch (err) { if (version === generation.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (version === generation.current) { inFlight.current = false; setLoading(false); } }
  };
  useEffect(() => {
    generation.current++; inFlight.current = false; snapshot.current = undefined; nextOffsetRef.current = 0;
    setPages([]); setNextOffset(0); setSelectedId(null);
    void loadPage(0);
    return () => { generation.current++; };
  }, [projectId, rootId, workspace]);
  useEffect(() => {
    let active = true; setDetail(null); setDetailError("");
    if (projectId && selectedId) void projectApi.gitCommit(projectId, selectedId, rootId)
      .then(value => { if (active) setDetail(value); })
      .catch(err => { if (active) setDetailError(String(err.message ?? err)); });
    return () => { active = false; };
  }, [projectId, rootId, selectedId]);
  const currentHeads = useMemo(() => new Set(workspace.worktrees.filter((item) => item.primary).map((item) => item.head)), [workspace.worktrees]);
  const dirtyHeads = useMemo(() => new Set(workspace.worktrees.filter((item) => item.dirty).map((item) => item.head)), [workspace.worktrees]);
  const filteredCommits = commits.filter((commit) => {
    const textMatch = `${commit.subject} ${commit.author} ${commit.id} ${commit.refs.join(" ")}`.toLowerCase().includes(query.toLowerCase());
    const filterMatch = filter === "all" || (filter === "merge" && commit.parents.length > 1) || (filter === "workspace" && (currentHeads.has(commit.id) || dirtyHeads.has(commit.id)));
    return textMatch && filterMatch;
  });
  const topology = useMemo(() => {
    if (!query && filter === "all") return buildTopology(filteredCommits);
    const visible = new Set(filteredCommits.map(commit => commit.id));
    return buildTopology(filteredCommits.map(commit => ({ ...commit, parents: commit.parents.filter(parent => visible.has(parent)) })));
  }, [filteredCommits, query, filter]);
  const railWidth = topology.reduce((width, row) => Math.max(width, laneX(row.nodeLane) + 22, ...row.connections.map(edge => laneX(Math.max(edge.from, edge.to)) + 22)), MIN_RAIL_WIDTH);
  const selected = commits.find((commit) => commit.id === selectedId);
  const graphHeight = filteredCommits.length * ROW_HEIGHT;

  if (!commits.length && !projectId) return <div className="history-tree-empty">当前仓库没有可展示的提交记录。</div>;
  return (
    <div className="history-tree">
      <header className="history-tree-toolbar">
        <label className="history-tree-search">
          <Search size={15} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提交、分支或作者" aria-label="搜索提交、分支或作者" />
        </label>
        <div className="history-tree-filters" role="group" aria-label="提交筛选">
          {([["all", "全部"], ["merge", "合并提交"], ["workspace", "工作区"]] as const).map(([id, label]) => (
            <button key={id} type="button" className={filter === id ? "is-active" : ""} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <span className="history-tree-count">{filteredCommits.length} / {commits.length} 条活动</span>
        {projectId && <button onClick={() => setAction({ action: "fetch" })}>Fetch</button>}
      </header>
      {actionResult && <div role="status">{actionResult.output && <pre>{actionResult.output}</pre>}{actionResult.operation && <><p>{actionResult.operation} 进行中 · {actionResult.conflicts.length} 个冲突文件</p><ul>{actionResult.conflicts.map(path => <li key={path}><button onClick={() => void openConflict(path)}>{path} · 解决冲突</button></li>)}</ul><button disabled={actionResult.conflicts.length > 0} onClick={() => setAction({ action: "continue" })}>继续操作</button><button onClick={() => setAction({ action: "abort" })}>中止操作</button></>}</div>}
      {conflictError && <p role="alert">{conflictError} <button onClick={refreshState}>刷新操作状态</button></p>}
      {projectId && conflictFile && <MergeFileViewer key={conflictFile.id} file={conflictFile} onClose={() => { setConflictFile(null); refreshState(); }} onSave={async input => { const saved = await projectApi.saveGitConflict(projectId, conflictFile.path, input, rootId); setConflictFile(saved); refreshState(); }} />}
      <div className="history-tree-viewport" onScroll={event => { const el = event.currentTarget; if (!error && nextOffset !== null && el.scrollTop + el.clientHeight >= el.scrollHeight - 120) void loadPage(nextOffset); }}>
      <div className="history-tree-table-wrap" style={{ paddingLeft: railWidth }}>
        {filteredCommits.length > 0 && <svg className="history-tree-rail" width={railWidth} height={graphHeight} viewBox={`0 0 ${railWidth} ${graphHeight}`} aria-hidden="true" preserveAspectRatio="none">
          {topology.flatMap((row, index) => row.connections.map((connection, connectionIndex) => (
            <path key={`${index}-${connectionIndex}`} d={topologyPath(connection.from, connection.to, index)} className={connection.merge ? "is-merge" : connection.from === 0 ? "is-main" : "is-branch"} />
          )))}
          {filteredCommits.map((commit, index) => {
            const lane = topology[index]?.nodeLane ?? 0;
            const merge = commit.parents.length > 1;
            return <circle key={commit.id} cx={laneX(lane)} cy={index * ROW_HEIGHT + ROW_HEIGHT / 2} r={merge ? 7 : 5} className={merge ? "is-merge" : currentHeads.has(commit.id) ? "is-current" : ""} />;
          })}
        </svg>}
        <div className="history-tree-table min-w-0">
          <div className="history-tree-scroll overflow-auto">
            <table aria-label="Git 提交历史" className="history-tree-content w-full border-collapse text-left text-xs">
              <thead><tr>
                <th scope="col">提交标题</th>
                <th scope="col">分支标签</th>
                <th scope="col">Commit ID</th>
                <th scope="col">作者</th>
                <th scope="col">时间</th>
                <th scope="col"><span className="sr-only">状态</span></th>
              </tr></thead>
              <tbody>
                {filteredCommits.map((commit) => {
                  const isCurrent = currentHeads.has(commit.id);
                  const isDirty = dirtyHeads.has(commit.id);
                  const isMerge = commit.parents.length > 1;
                  const isRebase = commit.rebase;
                  return (
                    <HistoryContextTarget key={commit.id} row target={commit.id} selected={selectedId === commit.id} onSelect={() => setSelectedId(commit.id)} onAction={setAction}>
                      <td>
                        <button type="button" className="history-table-title-button" title={commit.subject || "无提交说明"} onClick={() => setSelectedId(commit.id)}>
                          <strong>{commit.subject || "无提交说明"}</strong>
                        </button>
                      </td>
                      <td>
                        <div className="history-tree-ref-list">
                          {commit.refs.map((ref) => {
                            const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
                            const count = associations?.branches.find(branch => branch.ref === fullRef)?.sessions.length ?? 0;
                            return <span className="history-branch-group" key={ref}><HistoryContextTarget target={fullRef} onAction={setAction}><GitBranch size={12} />{ref.startsWith("refs/remotes/") ? "远端 · " : ""}{ref.replace(/^refs\/(heads|remotes|tags)\//, "")}</HistoryContextTarget>{projectId && <button className="history-session-count" title={`${count} 个未归档会话`} onClick={() => { setBranchSessions(fullRef); refreshAssociations(); }}>{count}</button>}</span>;
                          })}
                          {isMerge && <span className="history-tree-ref is-merge"><GitMerge size={12} />合并</span>}
                          {isRebase && <span className="history-tree-ref is-rebase">↻ rebase</span>}
                        </div>
                      </td>
                      <td><code title={commit.id}>{commit.id.slice(0, 8)}</code></td>
                      <td><span className="history-tree-author">{commit.author}</span></td>
                      <td><time dateTime={commit.authoredAt}>{shortDate(commit.authoredAt)}</time></td>
                      <td>
                        <span className={`history-tree-status ${isDirty ? "is-dirty" : isCurrent ? "is-current" : isMerge ? "is-merge" : isRebase ? "is-rebase" : ""}`} aria-label={isDirty ? "有未提交更改" : isCurrent ? "当前工作区 HEAD" : isMerge ? "合并提交" : isRebase ? "rebase 重写" : "普通提交"}>
                          {isDirty ? "!" : isCurrent ? "HEAD" : isMerge ? "↗" : isRebase ? "R" : "·"}
                        </span>
                      </td>
                    </HistoryContextTarget>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      </div>
      {error && <p role="alert">{error} <button onClick={() => void loadPage(0, true)}>刷新历史</button></p>}
      {projectId && nextOffset !== null && <button disabled={loading} onClick={() => void loadPage(nextOffset)}>{loading ? "加载中…" : error ? "重试" : "加载更多提交"}</button>}
      {projectId && action && <GitHistoryActionDialog projectId={projectId} rootId={rootId} head={actionHead} worktree={workspace.defaultPath} selection={action} onClose={() => setAction(null)} onDone={result => { setActionResult(result); refreshAssociations(); void loadPage(0, true); }} />}
      {!loading && !error && !commits.length && <p>当前仓库没有可展示的提交记录。</p>}
      {associationError && <p role="alert">{associationError} <button onClick={refreshAssociations}>重试会话索引</button></p>}
      {projectId && associations && <GitEpicPanel projectId={projectId} rootId={rootId} data={associations} onRefresh={refreshAssociations} />}
      {projectId && associations && branchSessions && <BranchSessionsDialog projectId={projectId} branch={branchSessions} data={associations} onClose={() => setBranchSessions(null)} />}
      {selected && <aside className="history-tree-detail"><div className="history-tree-detail-mark"><GitCommitHorizontal size={16} /></div><div className="history-commit-details"><strong>{selected.subject}</strong><p>{selected.id} · {selected.author} · {shortDate(selected.authoredAt)}</p>{detailError && <p role="alert">{detailError}</p>}{projectId && !detail && !detailError && <p>正在加载提交详情…</p>}{detail && <><p>作者：{detail.author} &lt;{detail.authorEmail}&gt; · {detail.authoredAt}</p><p>提交者：{detail.committer} &lt;{detail.committerEmail}&gt; · {detail.committedAt}</p><p>父提交：{detail.parents.join(" · ") || "初始提交"}</p><pre>{detail.message}</pre><h3>改动文件（{detail.files.length}）</h3><ul>{detail.files.map(file => <li key={file.path}><code>{file.status}</code> {file.previousPath && `${file.previousPath} → `}{file.path}</li>)}</ul><pre className="history-commit-diff">{detail.diff || "没有文本改动"}</pre></>}</div></aside>}
    </div>
  );
}
