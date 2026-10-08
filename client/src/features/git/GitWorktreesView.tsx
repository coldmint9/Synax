import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GitBranch, Plus, RefreshCw, Search, Trash2, MoreHorizontal, Scissors } from "lucide-react";
import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { projectApi, type GitWorkspaceSummary, type GitWorktreeSummary } from "../../adapters/transport/project";
import { cleanupReasons, type GitWorktreeCleanupPreview, type GitWorktreeCleanupResult } from "../../../../services/local-node/modules/git-worktree-management-contracts";
import { Button } from "../../shared/ui/ui/Button";
import { Field, Input, Label } from "../../shared/ui/ui/Field";
import { Select } from "../../shared/ui/ui/Select";
import { Dialog, DialogBody, DialogFooter, DialogPanel, DialogTitle } from "../../shared/ui/ui/Dialog";
import { Tab, TabGroup, TabList, TabPanel, TabPanels } from "../../shared/ui/ui/Tabs";
import "./gitWorktrees.css";
import { BranchSessionsDialog } from "./GitEpics";
import type { GitAssociations } from "../../../../services/local-node/modules/git-epic-contracts";

type Props = {
  projectId: string;
  rootId?: string;
  repositoryName: string;
  workspace: GitWorkspaceSummary;
  onUpdate: (workspace: GitWorkspaceSummary) => void;
  onBusy: (busy: boolean) => void;
  onHistory: (worktree: GitWorktreeSummary) => void;
};
const title = (item: GitWorktreeSummary) => item.branch ?? `${item.head.slice(0, 8)} · 分离 HEAD`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function GitWorktreesView({ projectId, rootId, repositoryName, workspace, onUpdate, onBusy, onHistory }: Props) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fresh, setFresh] = useState("");
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState(0);
  const [branch, setBranch] = useState("");
  const [existing, setExisting] = useState("");
  const [startPoint, setStartPoint] = useState("HEAD");
  const [path, setPath] = useState("");
  const [pathError, setPathError] = useState("");
  const [createError, setCreateError] = useState("");
  const [target, setTarget] = useState<GitWorktreeSummary | null>(null);
  const [cleanup, setCleanup] = useState<GitWorktreeCleanupPreview | null>(null);
  const [results, setResults] = useState<GitWorktreeCleanupResult[] | null>(null);
  const [prunePaths, setPrunePaths] = useState<string[] | null>(null);
  const [sessionLinks, setSessionLinks] = useState<GitAssociations | null>(null);
  const [sessionBranch, setSessionBranch] = useState<string | null>(null);
  const [cleanupProgress, setCleanupProgress] = useState<{ done: number; total: number } | null>(null);
  const chosenBranch = mode === 0 ? branch.trim() : existing;
  const cleanupCount = workspace.worktrees.filter(item => cleanupReasons(item).length === 0).length;
  const currentBranch = workspace.worktrees.find(item => item.path === workspace.defaultPath)?.branch;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; onBusy(false); };
  }, []);
  useEffect(() => {
    if (!creating) return;
    let current = true;
    setPath(""); setPathError("");
    if (!chosenBranch) return;
    const timer = window.setTimeout(() => {
      void projectApi.previewGitWorktree(projectId, chosenBranch, rootId)
        .then(result => { if (current) setPath(result.path); })
        .catch(cause => { if (current) setPathError(message(cause)); });
    }, 200);
    return () => { current = false; window.clearTimeout(timer); };
  }, [creating, chosenBranch, projectId, rootId]);

  async function run(action: () => Promise<void>, onError: (error: string) => void = setError) {
    if (locked.current) return;
    locked.current = true; setBusy(true); onBusy(true); setError("");
    try { await action(); }
    catch (cause) { if (alive.current) onError(message(cause)); }
    finally { locked.current = false; if (alive.current) { setBusy(false); onBusy(false); } }
  }
  async function reload() {
    const next = await projectApi.listGitWorkspaces(projectId, rootId);
    if (alive.current) onUpdate(next);
  }
  async function refreshAfterMutation() {
    try { await reload(); }
    catch (cause) { if (alive.current) setError(`操作结果已保留，但列表刷新失败：${message(cause)}。请刷新列表。`); }
  }
  function beginCreate() {
    setMode(0); setBranch(""); setExisting(""); setStartPoint(currentBranch ?? "HEAD");
    setPath(""); setCreateError(""); setCreating(true);
  }
  function submitCreate() {
    if (busy || !path || !chosenBranch || pathError) return;
        setCreateError(""); void run(async () => {
          const result = await projectApi.createGitWorktree(projectId, { rootId, branch: chosenBranch, createBranch: mode === 0, startPoint: mode === 0 ? startPoint : undefined });
          if (!alive.current) return;
          setFresh(result.worktree.path); setCreating(false); setQuery(""); setFilter("all"); setNotice(`工作树已创建：${title(result.worktree)}`);
          await refreshAfterMutation();
        }, setCreateError);

  }
  const visible = workspace.worktrees.filter(item =>
    `${title(item)} ${item.path}`.toLowerCase().includes(query.trim().toLowerCase()) &&
    (filter === "all" || filter === "dirty" && item.dirty || filter === "active" && (item.activeSessionCount ?? 0) > 0 || filter === "stale" && item.prunable));
  const reasons = target ? cleanupReasons(target) : [];

  return <>
    {notice && <p className="worktree-notice" role="status">{notice}</p>}
    {error && <div className="worktree-error" role="alert">{error} <Button className="git-control" size="sm" disabled={busy} onClick={() => void run(reload)}>刷新列表</Button></div>}
    <section className="git-worktree-island" aria-label={`${repositoryName} 工作树管理`} aria-busy={busy}>
      <header className="worktree-toolbar">
        <div className="worktree-filters">
          <Field className="worktree-search"><Search size={14} aria-hidden="true" /><Input aria-label="搜索分支或目录" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索分支或目录…" /></Field>
          <Select aria-label="工作树状态筛选" value={filter} onChange={value => setFilter(value ?? "all")} options={[{ value: "all", label: "全部状态" }, { value: "dirty", label: "有未提交修改" }, { value: "active", label: "使用中" }, { value: "stale", label: "目录失效" }]} triggerClassName="git-control !rounded-full" />
        </div>
        <div className="worktree-actions">
          <Button className="git-control" variant="ghost" size="sm" disabled={busy} onClick={() => void run(reload)}><RefreshCw size={14} />刷新</Button>
          <Button className="git-control" variant="danger-soft" size="sm" disabled={busy} title="预览当前仓库全部可删除工作树，不受搜索筛选影响" onClick={() => void run(async () => {
            const preview = await projectApi.previewGitWorktreeCleanup(projectId, rootId);
            if (alive.current) { setCleanup(preview); setResults(null); }
          })}><Scissors size={14} />一键清理 · {cleanupCount}</Button>
          <Button className="git-control" variant="primary" size="sm" disabled={busy} onClick={beginCreate}><Plus size={14} />创建工作树</Button>
        </div>
      </header>
      <div className="worktree-table-scroll"><table aria-label="Git 工作树列表">
        <thead><tr><th>分支 / 工作目录</th><th>目录状态</th><th>关联会话</th><th>操作</th></tr></thead>
        <tbody>{visible.map(item => <tr key={item.path} className={fresh === item.path ? "is-fresh" : undefined}>
          <td><div className="worktree-branch"><GitBranch size={15} aria-hidden="true" /><strong>{title(item)}</strong>{item.primary && <span className="worktree-badge">主工作树</span>}{fresh === item.path && <span className="worktree-badge is-green">刚创建</span>}</div><code className="worktree-path" title={item.path}>{item.path}</code></td>
          <td><span className={`worktree-badge ${item.dirty ? "is-amber" : item.prunable ? "is-red" : ""}`}>{item.prunable ? "目录已失效" : item.locked ? "已锁定" : item.statusKnown !== true ? "状态未知" : item.dirty ? "有未提交修改" : "无未提交修改"}</span></td>
          <td>{(item.activeSessionCount ?? 0) > 0 && <span className="worktree-badge is-green">使用中 · {item.activeSessionCount}</span>}{item.sessionCount && item.branch ? <Button className="git-control worktree-session-count" size="xs" variant="ghost" disabled={busy} onClick={() => void run(async () => {
            const links = await projectApi.gitAssociations(projectId, rootId);
            if (alive.current) { setSessionLinks(links); setSessionBranch(`refs/heads/${item.branch}`); }
          })}>{item.sessionCount} 个关联会话</Button> : <span className="worktree-session-count">{item.sessionCount ? `${item.sessionCount} 个关联会话` : "—"}</span>}</td>
          <td><div className="worktree-row-actions">
            {item.prunable ? <Button className="git-control" size="xs" variant="ghost" disabled={busy} onClick={() => void run(async () => {
              const preview = await projectApi.previewGitWorktreePrune(projectId, rootId);
              if (alive.current) setPrunePaths(preview.paths);
            })}>清理记录</Button> : <><Button className="git-control" size="xs" variant="ghost" disabled={busy} onClick={() => {
              const params = new URLSearchParams({ worktree: item.path });
              if (rootId) params.set("rootId", rootId);
              navigate(`/projects/${encodeURIComponent(projectId)}/sessions/new?${params}`);
            }}>新建会话</Button><Button className="git-control" size="xs" variant="ghost" disabled={busy} onClick={() => onHistory(item)}>查看历史</Button></>}
            <Menu><MenuButton className="git-control" as={Button} size="xs" variant="ghost" iconOnly disabled={busy} aria-label={`${title(item)} 更多操作`}><MoreHorizontal size={15} /></MenuButton>
              <MenuItems anchor="bottom end" portal className="worktree-menu">
                <MenuItem><button onClick={() => void run(async () => { await navigator.clipboard.writeText(item.path); setNotice("目录路径已复制"); })}>复制目录路径</button></MenuItem>
                <MenuItem disabled={item.primary || item.prunable}><button className="text-destructive" onClick={() => { setTarget(item); setError(""); }}>删除工作树…</button></MenuItem>
              </MenuItems>
            </Menu>
          </div></td>
        </tr>)}</tbody>
      </table></div>
      {!visible.length && <div className="worktree-empty"><p>{workspace.worktrees.length ? "没有匹配的工作树" : "没有可显示的工作树"}</p>{workspace.worktrees.length > 0 && <Button className="git-control" variant="ghost" onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选</Button>}</div>}
      <footer className="worktree-footer">{workspace.worktrees.length === 1 && workspace.worktrees[0].primary ? "只有主工作树 · 创建工作树以并行处理任务" : `${workspace.worktrees.length} 个工作树 · 当前仓库 ${repositoryName}`}</footer>
    </section>

    {sessionLinks && sessionBranch && <BranchSessionsDialog projectId={projectId} data={sessionLinks} branch={sessionBranch} onClose={() => setSessionBranch(null)} />}
    <Dialog open={creating} onClose={() => setCreating(false)} dismissible={!busy}>
      <DialogPanel className="max-w-xl worktree-dialog"><form className="contents" onSubmit={event => { event.preventDefault(); submitCreate(); }}><DialogTitle>创建工作树</DialogTitle><DialogBody>
        <p className="worktree-hint">仓库：{repositoryName}</p>
        <TabGroup selectedIndex={mode} onChange={index => { setMode(index); setCreateError(""); }}>
          <TabList aria-label="分支来源"><Tab disabled={busy}>新建分支</Tab><Tab disabled={busy}>已有分支</Tab></TabList>
          <TabPanels><TabPanel><Field><Label>分支名称</Label><Input autoFocus value={branch} disabled={busy} autoComplete="off" onChange={event => { setBranch(event.target.value); setCreateError(""); }} placeholder="例如 feat/git-worktree" /></Field>
            <Select label="基于" value={startPoint} disabled={busy} onChange={value => setStartPoint(value ?? "HEAD")} options={[{ value: "HEAD", label: "HEAD · 当前提交" }, ...workspace.branches.map(item => ({ value: item.name, label: item.name }))]} /></TabPanel>
            <TabPanel><Select label="已有分支" value={existing} disabled={busy} placeholder="选择尚未检出的分支" onChange={value => setExisting(value ?? "")} options={workspace.branches.map(item => ({ value: item.name, label: `${item.name}${item.checkedOutPath ? " · 已在工作树检出" : ""}`, disabled: Boolean(item.checkedOutPath) }))} /><p className="worktree-hint">同一分支只能在一个工作树中检出。</p></TabPanel>
          </TabPanels>
        </TabGroup>
        <div className="worktree-directory-preview"><span>自动生成的工作目录</span><code>{path || (chosenBranch ? "正在预览目录…" : "填写或选择分支后显示")}</code></div>
        {pathError && <p role="alert" className="worktree-error">{pathError}</p>}
        {createError && <p role="alert" className="worktree-error">{createError}</p>}
        <p className="worktree-hint">创建后留在列表，可选择新建会话或查看历史。</p>
      </DialogBody><DialogFooter><Button className="git-control" disabled={busy} onClick={() => setCreating(false)}>取消</Button><Button className="git-control" variant="primary" pending={busy} disabled={!path || !chosenBranch || Boolean(pathError)} type="submit">创建工作树</Button></DialogFooter></form></DialogPanel>
    </Dialog>

    <Dialog open={Boolean(target)} onClose={() => setTarget(null)} dismissible={!busy}>
      <DialogPanel className="max-w-xl worktree-dialog"><DialogTitle>{reasons.length ? "暂时无法删除工作树" : "删除工作树？"}</DialogTitle><DialogBody>
        {target && <div className="worktree-directory-preview"><strong>{title(target)}</strong><code>{target.path}</code></div>}
        {reasons.length ? <ul>{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : <p>将删除工作目录与工作树登记。分支、提交和历史会话保留。删除无法撤销。</p>}
        {error && <p role="alert" className="worktree-error">{error}</p>}
      </DialogBody><DialogFooter><Button className="git-control" disabled={busy} onClick={() => setTarget(null)}>{reasons.length ? "返回列表" : "取消"}</Button>{!reasons.length && <Button className="git-control" variant="danger" pending={busy} onClick={() => void run(async () => {
        if (!target) return;
        await projectApi.removeGitWorktree(projectId, { path: target.path, rootId });
        setTarget(null); setNotice("工作树已删除，分支和提交已保留。"); await refreshAfterMutation();
      })}><Trash2 size={14} />删除工作树</Button>}</DialogFooter></DialogPanel>
    </Dialog>

    <Dialog open={Boolean(cleanup)} onClose={() => setCleanup(null)} dismissible={!busy}>
      <DialogPanel className="max-w-2xl worktree-dialog"><DialogTitle>清理可删除的工作树</DialogTitle><DialogBody>
        <p>仓库：{repositoryName} · 可删除 {cleanup?.candidates.length ?? 0} 个 · 保留 {cleanup?.retained.length ?? 0} 个</p>
        <p className="worktree-hint">范围为当前仓库全部工作树，不受搜索和筛选影响。删除目录与登记，保留分支、提交和历史会话。删除无法撤销。</p>
        {results ? <><p role="status">已清理 {results.filter(item => item.status === "removed").length} 个，跳过 / 失败 {results.filter(item => item.status !== "removed").length} 个。</p><ul className="worktree-preview-list">{results.map(item => <li key={item.path}><strong>{item.branch ?? item.path}</strong><code>{item.path}</code><span>{item.status === "removed" ? "已清理" : item.reason ?? "未删除"}</span></li>)}</ul></> : <>
          <ul className="worktree-preview-list">{cleanup?.candidates.map(item => <li key={item.path}><strong>{title(item)}</strong><code>{item.path}</code></li>)}</ul>
          {!cleanup?.candidates.length && <p>没有可清理的工作树。</p>}
          <details><summary>保留的工作树及原因</summary><ul className="worktree-preview-list">{cleanup?.retained.map(({ worktree, reasons: keptReasons }) => <li key={worktree.path}><strong>{title(worktree)}</strong><code>{worktree.path}</code><span>{keptReasons.join("；")}</span></li>)}</ul></details>
          
        </>}
        {busy && cleanupProgress && <p role="status">正在清理 {cleanupProgress.done} / {cleanupProgress.total}，请等待逐项校验和处理结果…</p>}
        {error && <p role="alert" className="worktree-error">{error}。请关闭后重新预览。</p>}
      </DialogBody><DialogFooter><Button className="git-control" disabled={busy} onClick={() => setCleanup(null)}>{results ? "完成" : "取消"}</Button>{!results && Boolean(cleanup?.candidates.length) && <Button className="git-control" variant="danger" pending={busy} onClick={() => void run(async () => {
        if (!cleanup) return;
        const snapshot = [...cleanup.candidates];
        const resultItems: GitWorktreeCleanupResult[] = [];
        setCleanupProgress({ done: 0, total: snapshot.length });
        for (const item of snapshot) {
          try {
            const response = await projectApi.cleanupGitWorktrees(projectId, [item.path], rootId);
            resultItems.push(...response.results);
          } catch (cause) {
            resultItems.push({ path: item.path, branch: item.branch, status: "failed", reason: `无法确认处理结果：${message(cause)}。请刷新列表核对。` });
          }
          if (alive.current) setCleanupProgress({ done: resultItems.length, total: snapshot.length });
        }
        if (!alive.current) return;
        setCleanupProgress(null);
        setResults(resultItems); setNotice(`清理完成：${resultItems.filter(item => item.status === "removed").length} 个已删除，其他对象已保留。`);
        await refreshAfterMutation();
      })}>确认清理 {cleanup?.candidates.length} 个</Button>}</DialogFooter></DialogPanel>
    </Dialog>

    <Dialog open={prunePaths !== null} onClose={() => setPrunePaths(null)} dismissible={!busy}>
      <DialogPanel className="max-w-xl worktree-dialog"><DialogTitle>清理失效工作树记录</DialogTitle><DialogBody>
        <p>将清理当前仓库以下全部失效登记。保留分支与历史会话，不删除有效目录。</p>
        <ul className="worktree-preview-list">{prunePaths?.map(item => <li key={item}><code>{item}</code></li>)}</ul>
        {!prunePaths?.length && <p>没有可清理的失效记录。</p>}{error && <p className="worktree-error" role="alert">{error}。请关闭后重新预览。</p>}
      </DialogBody><DialogFooter><Button className="git-control" disabled={busy} onClick={() => setPrunePaths(null)}>取消</Button>{Boolean(prunePaths?.length) && <Button className="git-control" variant="danger" pending={busy} onClick={() => void run(async () => {
        await projectApi.pruneGitWorktrees(projectId, rootId, prunePaths ?? []);
        setPrunePaths(null); setNotice("失效工作树登记已清理，分支与历史会话已保留。"); await refreshAfterMutation();
      })}>确认清理 {prunePaths?.length} 条记录</Button>}</DialogFooter></DialogPanel>
    </Dialog>
  </>;
}
