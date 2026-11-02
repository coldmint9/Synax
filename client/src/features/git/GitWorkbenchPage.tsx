import { useEffect, useRef, useState } from "react";
import {
  GitFork,

  GitCommitHorizontal,
  FolderGit2,
  ArrowLeftRight,
  RefreshCw,
} from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  projectApi,
  type GitWorkspaceSummary,
  type ProjectWorkspaceRoot,
} from "../../adapters/transport/project";
import { Tab, TabGroup, TabList } from "../../shared/ui/ui/Tabs";
import { IslandSelection } from "../../app/layouts/IslandSelection";
import { GitToolbarContent } from "./GitToolbarPortal";
import { MergeRequestDetail } from "./MergeRequestDetail";
import GitHistoryTree from "./GitHistoryTree";
import { GitWorktreesView } from "./GitWorktreesView";
import { QuickMergeBoardView } from "./QuickMergeBoard";
import { Button } from "../../shared/ui/ui/Button";
import { fetchStaleResource, readStaleResource, writeStaleResource } from "../../shared/lib/staleResource";
import "./gitWorkbench.css";
import "./gitHistory.css";
import "./mergeRequest.css";
type View = "branches" | "worktrees" | "quick";
type GitWorkbenchIndex = {
  roots: ProjectWorkspaceRoot[];
};

const gitWorkbenchIndexKey = (projectId: string) => `git-workbench:index:${projectId}`;
const gitWorkspaceKey = (projectId: string, rootId: string, mode: "inventory" | "full") =>
  `git-workbench:workspace:${mode}:${projectId}:${rootId}`;
export default function GitWorkbenchPage() {
  const { projectId, mrId } = useParams();
  if (!projectId) return null;
  return mrId ? (
    <MergeRequestDetail
      key={`${projectId}/${mrId}`}
      projectId={projectId}
      mrId={mrId}
    />
  ) : (
    <GitWorkbench key={projectId} projectId={projectId} />
  );
}
function GitWorkbench({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView = searchParams.get("view");
  const view: View =
    requestedView === "quick" || requestedView === "worktrees"
      ? requestedView
      : "branches";
  const setView = (next: View) =>
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        params.set("view", next);
        return params;
      },
      { replace: true },
    );
  const cachedIndex = readStaleResource<GitWorkbenchIndex>(gitWorkbenchIndexKey(projectId));
  const [roots, setRoots] = useState<ProjectWorkspaceRoot[]>(() => cachedIndex?.roots ?? []);
  const [rootId, setRootId] = useState<string | null>(() => {
    const available = cachedIndex?.roots.filter((root) => root.status === "available") ?? [];
    return available.find(root => root.id === searchParams.get("rootId"))?.id ?? available.find((root) => root.role === "primary")?.id ?? available[0]?.id ?? null;
  });
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const statusReadVersion = useRef(0);
  const [inventoryReady, setInventoryReady] = useState<string | null>(null);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const requestedRootId = searchParams.get("rootId");
  useEffect(() => {
    if (!roots.length || worktreeBusy) return;
    const requested = roots.find(root => root.id === requestedRootId && root.status === "available");
    if (requested) setRootId(requested.id);
  }, [roots, requestedRootId, worktreeBusy]);
  const [workspace, setWorkspace] = useState<GitWorkspaceSummary | null>(() =>
    rootId ? readStaleResource<GitWorkspaceSummary>(gitWorkspaceKey(projectId, rootId, "inventory")) ?? null : null,
  );
  const [error, setError] = useState("");
  const [branchError, setBranchError] = useState("");
  const [loading, setLoading] = useState(() => cachedIndex === undefined);
  const [branchLoading, setBranchLoading] = useState(() =>
    rootId !== null && readStaleResource<GitWorkspaceSummary>(gitWorkspaceKey(projectId, rootId, "inventory")) === undefined,
  );
  const openRequest = (id: string) =>
    navigate(
      `/projects/${encodeURIComponent(projectId)}/git/mr/${encodeURIComponent(id)}`,
    );
  useEffect(() => {
    let active = true;
    // Unblock repository views as soon as roots arrive, independently of MR I/O.
    projectApi.getWorkspace(projectId)
      .then(nextWorkspace => {
        if (!active) return;
        writeStaleResource(gitWorkbenchIndexKey(projectId), { roots: nextWorkspace.roots });
        setRoots(nextWorkspace.roots);
        setRootId(current => {
          if (current && nextWorkspace.roots.some(root => root.id === current && root.status === "available")) return current;
          return nextWorkspace.roots.find(root => root.id === requestedRootId && root.status === "available")?.id ?? nextWorkspace.roots.find(root => root.role === "primary" && root.status === "available")?.id ?? nextWorkspace.roots.find(root => root.status === "available")?.id ?? null;
        });
      })
      .catch(err => { if (active) setError(String(err.message ?? err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => {
    if (rootId === null) return;
    let active = true;
    const key = gitWorkspaceKey(projectId, rootId, "inventory");
    setWorkspace(readStaleResource<GitWorkspaceSummary>(key) ?? null);
    setBranchError("");
    setBranchLoading(true);
    setInventoryReady(null);
    void fetchStaleResource(key, () => projectApi.listGitWorkspaces(projectId, rootId, "inventory"))
      .then((value) => {
        writeStaleResource(key, value);
        if (active) {
          setWorkspace(value);
          setInventoryReady(`${projectId}/${rootId}/${workspaceRevision}`);
        }
      })
      .catch((err) => {
        if (active) setBranchError(String(err.message ?? err));
      })
      .finally(() => {
        if (active) setBranchLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, rootId, workspaceRevision]);
  useEffect(() => {
    if (view !== "worktrees" || rootId === null || inventoryReady !== `${projectId}/${rootId}/${workspaceRevision}`) return;
    let active = true;
    const version = ++statusReadVersion.current;
    const key = gitWorkspaceKey(projectId, rootId, "full");
    const cached = readStaleResource<GitWorkspaceSummary>(key);
    if (cached) setWorkspace(cached);
    void projectApi.listGitWorkspaces(projectId, rootId)
      .then((value) => {
        if (active && version === statusReadVersion.current) {
          writeStaleResource(key, value);
          setWorkspace(value);
        }
      })
      .catch(err => { if (active) setBranchError(String(err.message ?? err)); });
    return () => { active = false; };
  }, [view, projectId, rootId, workspaceRevision, inventoryReady]);
  return (
    <main
      className={`git-workbench git-workbench-modern mr-modern-index ${view === "branches" ? "git-history-page" : ""}`}
    >
      <GitToolbarContent>
        <nav aria-label="Git 视图" className="git-island-views">
          <IslandSelection activeKey={view}>
            {(
              [
                ["branches", "历史树"],
                ["worktrees", "工作树"],
                ["quick", "快捷合并"],
              ] as [View, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                data-island-option={id}
                type="button"
                className={`wh-pill-btn ${view === id ? "wh-pill-btn--soft" : ""}`}
                aria-current={view === id ? "page" : undefined}
                disabled={worktreeBusy}
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </IslandSelection>
        </nav>
        <select
          className="git-island-view-select"
          aria-label="Git 视图"
          value={view}
          disabled={worktreeBusy}
          onChange={(event) => setView(event.target.value as View)}
        >
          <option value="branches">历史树</option>
          <option value="worktrees">工作树</option>
          <option value="quick">快捷合并</option>
        </select>
      </GitToolbarContent>
      <header className="git-page-heading flex shrink-0 items-center justify-between gap-5">
        <div className="flex min-w-0 items-center gap-3.5">
          <span
            className="grid size-11 shrink-0 place-items-center rounded-2xl border border-[var(--ui-line)] bg-[var(--ui-panel)] text-[var(--ui-subtle)]"
            aria-hidden="true"
          >
            {view === "branches" ? (
              <GitCommitHorizontal size={22} strokeWidth={1.5} />
            ) : view === "worktrees" ? (
              <GitFork size={21} strokeWidth={1.5} />
            ) : (
              <ArrowLeftRight size={21} strokeWidth={1.5} />
            )}
          </span>
          <div className="min-w-0">
            <h1>
              {view === "branches"
                ? "历史树"
                : view === "worktrees" ? "工作树" : "快捷合并"}
            </h1>
            <span
              className="mt-1.5 block truncate font-mono text-[11px] text-[var(--ui-subtle)]"
              title={workspace?.repositoryRoot}
            >
              {workspace?.repositoryRoot ?? "Git 工作台"}
            </span>
          </div>
        </div>
        <TabGroup
          selectedIndex={Math.max(
            0,
            roots.findIndex((root) => root.id === rootId),
          )}
          onChange={(index) => {
            setRootId(roots[index].id);
            setSearchParams(current => { const next = new URLSearchParams(current); next.set("rootId", roots[index].id); next.delete("commit"); return next; }, { replace: true });
          }}
          className="min-w-0 max-w-[50%]"
        >
          <TabList
            className="mr-root-tabs !gap-1 rounded-xl border border-[var(--ui-line)] bg-[var(--ui-panel)] p-1"
            aria-label="仓库"
          >
            <FolderGit2
              size={15}
              className="mx-2 shrink-0 text-[var(--ui-subtle)]"
              aria-hidden="true"
            />
            {!roots.length && (
              <span className="px-2 py-1.5 text-xs text-[var(--ui-subtle)]">
                项目默认仓库
              </span>
            )}
            {roots.map((root) => (
              <Tab
                key={root.id}
                className="git-control !min-w-0 !rounded-lg !px-3 !py-2 !text-xs"
                disabled={worktreeBusy || root.status !== "available"}
                title={root.name}
              >
                <span className="truncate">{root.name}</span>
              </Tab>
            ))}
          </TabList>
        </TabGroup>
      </header>
      {error && (
        <p className="mr-error" role="alert">
          {error}
        </p>
      )}
      {branchError && (
        <p className="mr-error" role="alert">
          仓库信息不可用：{branchError}
        </p>
      )}
      {loading ? (
        <div className="mr-empty" role="status">
          正在加载 Git 工作台…
        </div>
      ) : (
        <>
          {view === "worktrees" && (
            rootId === null || (branchLoading && !workspace) ? <p className="mr-empty" role="status">正在读取工作树…</p> : !workspace ?
            <div className="mr-empty"><p>无法读取工作树，请检查仓库路径与权限。</p><Button onClick={() => setWorkspaceRevision(value => value + 1)}>重试</Button></div> :
            <GitWorktreesView key={`${projectId}/${rootId}`} projectId={projectId} rootId={rootId || undefined}
              repositoryName={roots.find(root => root.id === rootId)?.name ?? "当前仓库"}
              workspace={workspace} onUpdate={value => {
                statusReadVersion.current++;
                writeStaleResource(gitWorkspaceKey(projectId, rootId ?? "", "full"), value);
                setWorkspace(value);
              }} onBusy={setWorktreeBusy}
              onHistory={item => setSearchParams(current => { const next = new URLSearchParams(current); next.set("view", "branches"); if (rootId) next.set("rootId", rootId); next.set("commit", item.head); return next; })} />
          )}
          {view === "quick" && (
            <QuickMergeBoardView
              projectId={projectId}
              rootId={rootId ?? undefined}
              primaryRoot={roots.find((root) => root.id === rootId)?.role === "primary"}
              branches={workspace?.branches.map((branch) => branch.name) ?? []}
              onOpenMerge={openRequest}
            />
          )}
          {view === "branches" && (
            <section className="mr-history-card flex min-h-0 flex-1 flex-col">
              {branchLoading && !workspace ? (
                <div
                  role="status"
                  className="git-history-loading flex flex-1 items-center justify-center gap-3 rounded-[20px] border border-[var(--ui-line)] bg-[var(--ui-panel)] text-sm text-[var(--ui-subtle)]"
                >
                  <RefreshCw
                    size={17}
                    className="animate-spin motion-reduce:animate-none"
                  />
                  正在加载提交历史…
                </div>
              ) : !workspace ? (
                <p className="mr-empty">无法读取仓库历史。</p>
              ) : (
                <GitHistoryTree
                  key={`${projectId}/${rootId}`}
                  workspace={workspace}
                  projectId={projectId}
                  rootId={rootId ?? undefined}
                  focusCommitId={searchParams.get("commit") ?? undefined}
                />
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
