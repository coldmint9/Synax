import { useCallback, useEffect, useState } from "react";
import {
  GitMerge,
  ChevronRight,
  GitCommitHorizontal,
  FolderGit2,
  SlidersHorizontal,
  Plus,
  RefreshCw,
  Play,
  Trash2,
} from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  projectApi,
  type GitWorkspaceSummary,
  type ProjectWorkspaceRoot,
} from "../../../lib/api/project";
import {
  gitMrApi,
  type MergePreset,
  type MergeRequest,
  type MergeRequestInput,
} from "../../../lib/api/gitMr";
import { MergeRequestForm } from "./MergeRequestForm";
import { Tab, TabGroup, TabList } from "../../components/ui/Tabs";
import { IslandSelection } from "../../layouts/IslandSelection";
import { GitToolbarContent } from "./GitToolbarPortal";
import { MergeRequestDetail } from "./MergeRequestDetail";
import GitHistoryTree from "./GitHistoryTree";
import { Button } from "../../components/ui/Button";
import { isTerminal, statusLabels } from "./mergeUi";
import "./gitWorkbench.css";
import "./gitHistory.css";
import "./mergeRequest.css";
type View = "requests" | "branches" | "presets";
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
    requestedView === "requests" || requestedView === "presets"
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
  const [requests, setRequests] = useState<MergeRequest[]>([]);
  const [presets, setPresets] = useState<MergePreset[]>([]);
  const [roots, setRoots] = useState<ProjectWorkspaceRoot[]>([]);
  const [rootId, setRootId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<GitWorkspaceSummary | null>(null);
  const [error, setError] = useState("");
  const [branchError, setBranchError] = useState("");
  const [loading, setLoading] = useState(true);
  const [branchLoading, setBranchLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const openRequest = (id: string) =>
    navigate(
      `/projects/${encodeURIComponent(projectId)}/git/mr/${encodeURIComponent(id)}`,
    );
  const load = useCallback(async () => {
    const [nextRequests, nextPresets, nextWorkspace] = await Promise.all([
      gitMrApi.list(projectId),
      gitMrApi.presets(projectId),
      projectApi.getWorkspace(projectId),
    ]);
    setRequests(nextRequests);
    setPresets(nextPresets);
    setRoots(nextWorkspace.roots);
    setRootId(
      (current) =>
        current ??
        nextWorkspace.roots.find(
          (root) => root.role === "primary" && root.status === "available",
        )?.id ??
        nextWorkspace.roots.find((root) => root.status === "available")?.id ??
        "",
    );
  }, [projectId]);
  useEffect(() => {
    let active = true;
    Promise.all([
      gitMrApi.list(projectId),
      gitMrApi.presets(projectId),
      projectApi.getWorkspace(projectId),
    ])
      .then(([nextRequests, nextPresets, nextWorkspace]) => {
        if (!active) return;
        setRequests(nextRequests);
        setPresets(nextPresets);
        setRoots(nextWorkspace.roots);
        setRootId(
          nextWorkspace.roots.find(
            (root) => root.role === "primary" && root.status === "available",
          )?.id ??
            nextWorkspace.roots.find((root) => root.status === "available")
              ?.id ??
            "",
        );
      })
      .catch((err) => {
        if (active) setError(String(err.message ?? err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  useEffect(() => {
    if (rootId === null) return;
    let active = true;
    setWorkspace(null);
    setBranchError("");
    setBranchLoading(true);
    projectApi
      .listGitWorkspaces(projectId, rootId || undefined)
      .then((value) => {
        if (active) setWorkspace(value);
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
  }, [projectId, rootId, refreshVersion]);
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function create(input: MergeRequestInput, presetName?: string) {
    // Save structured policy before running it; manual requests never silently finalize.
    if (presetName) await gitMrApi.savePreset(projectId, presetName, input);
    const mr = await gitMrApi.create(projectId, {
      ...input,
      autoFinalize: false,
    });
    try {
      await gitMrApi.action(projectId, mr.id, "prepare", mr.version);
    } finally {
      openRequest(mr.id);
    }
  }
  const filteredRequests = requests.filter(
    (mr) =>
      !rootId ||
      mr.rootId === rootId ||
      (!mr.rootId &&
        roots.find((root) => root.id === rootId)?.role === "primary"),
  );
  const filteredPresets = presets.filter(
    (preset) =>
      !rootId ||
      preset.input.rootId === rootId ||
      (!preset.input.rootId &&
        roots.find((root) => root.id === rootId)?.role === "primary"),
  );
  return (
    <main
      className={`git-workbench git-workbench-modern mr-modern-index ${view === "branches" ? "git-history-page" : ""}`}
    >
      <GitToolbarContent>
        <nav aria-label="Git 视图" className="git-island-views">
          <IslandSelection activeKey={view}>
            {(
              [
                ["requests", "合并请求"],
                ["branches", "历史树"],
                ["presets", "预设"],
              ] as [View, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                data-island-option={id}
                type="button"
                className={`wh-pill-btn ${view === id ? "wh-pill-btn--soft" : ""}`}
                aria-current={view === id ? "page" : undefined}
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
          onChange={(event) => setView(event.target.value as View)}
        >
          <option value="requests">合并请求</option>
          <option value="branches">历史树</option>
          <option value="presets">预设</option>
        </select>
        <span className="wh-divider" aria-hidden="true" />
        <button
          type="button"
          className="wh-pill-btn wh-pill-btn--neutral"
          disabled={busy || loading}
          aria-label="刷新 Git 工作台"
          title="刷新 Git 工作台"
          onClick={() =>
            void perform(async () => {
              setRefreshVersion((value) => value + 1);
            })
          }
        >
          <RefreshCw size={14} />
          <span className="git-island-action-label">刷新</span>
        </button>
        <button
          type="button"
          className="wh-pill-btn wh-pill-btn--primary"
          disabled={loading || branchLoading || !workspace}
          onClick={() => setCreateOpen(true)}
          aria-label="新建 MR"
          title="新建 MR"
        >
          <Plus size={14} />
          <span className="git-island-action-label">新建 MR</span>
        </button>
      </GitToolbarContent>
      <header className="git-page-heading flex shrink-0 items-center justify-between gap-5">
        <div className="flex min-w-0 items-center gap-3.5">
          <span
            className="grid size-11 shrink-0 place-items-center rounded-2xl border border-[var(--ui-line)] bg-[var(--ui-panel)] text-[var(--ui-subtle)]"
            aria-hidden="true"
          >
            {view === "branches" ? (
              <GitCommitHorizontal size={22} strokeWidth={1.5} />
            ) : view === "requests" ? (
              <GitMerge size={21} strokeWidth={1.5} />
            ) : (
              <SlidersHorizontal size={21} strokeWidth={1.5} />
            )}
          </span>
          <div className="min-w-0">
            <h1>
              {view === "branches"
                ? "历史树"
                : view === "requests"
                  ? "合并请求"
                  : "合并预设"}
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
          onChange={(index) => setRootId(roots[index].id)}
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
                disabled={root.status !== "available"}
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
          {view === "requests" && (
            <div className="mr-index-content">
              {!filteredRequests.length ? (
                <div className="mr-empty mr-index-empty">
                  <span className="mr-index-empty-icon">
                    <GitMerge size={28} strokeWidth={1.5} />
                  </span>
                  <h2>还没有本地合并请求</h2>
                  <p>选择源分支与目标分支，在更新目标前审阅合并结果。</p>
                  <Button
                    variant="primary"
                    size="lg"
                    className="git-control !rounded-xl"
                    disabled={!workspace}
                    onClick={() => setCreateOpen(true)}
                  >
                    <Plus size={14} aria-hidden="true" />
                    创建第一个 MR
                  </Button>
                </div>
              ) : (
                [
                  {
                    label: "需要处理",
                    items: filteredRequests.filter(
                      (mr) => mr.status !== "draft" && !isTerminal(mr.status),
                    ),
                  },
                  {
                    label: "草稿",
                    items: filteredRequests.filter(
                      (mr) => mr.status === "draft",
                    ),
                  },
                  {
                    label: "已完成",
                    items: filteredRequests.filter((mr) =>
                      isTerminal(mr.status),
                    ),
                  },
                ]
                  .filter((group) => group.items.length)
                  .map((group) => (
                    <section key={group.label} className="mr-request-group">
                      <h2>
                        {group.label}{" "}
                        <span className="mr-muted">{group.items.length}</span>
                      </h2>
                      <div className="mr-request-list">
                        {group.items.map((mr) => (
                          <button
                            className="mr-request-card"
                            key={mr.id}
                            onClick={() => openRequest(mr.id)}
                          >
                            <span
                              className="mr-request-icon"
                              data-status={mr.status}
                            >
                              <GitMerge
                                size={17}
                                strokeWidth={1.6}
                                aria-hidden="true"
                              />
                            </span>
                            <div className="mr-request-text">
                              <strong>{mr.title}</strong>
                              <span>
                                {mr.steps
                                  .map((step) => step.branch)
                                  .join(" → ")}{" "}
                                → {mr.target}
                              </span>
                            </div>
                            <div className="mr-request-meta">
                              <span
                                className={`mr-status mr-status-${mr.status}`}
                              >
                                {statusLabels[mr.status]}
                              </span>
                              <time dateTime={mr.updatedAt}>
                                {new Date(mr.updatedAt).toLocaleString()}
                              </time>
                            </div>
                            <ChevronRight
                              size={15}
                              className="mr-request-chevron"
                              aria-hidden="true"
                            />
                          </button>
                        ))}
                      </div>
                    </section>
                  ))
              )}
            </div>
          )}
          {view === "branches" && (
            <section className="mr-history-card flex min-h-0 flex-1 flex-col">
              {branchLoading ? (
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
                  key={`${projectId}/${rootId}/${refreshVersion}`}
                  workspace={workspace}
                  projectId={projectId}
                  rootId={rootId ?? undefined}
                />
              )}
            </section>
          )}
          {view === "presets" && (
            <section className="mr-card">
              <h2>一键预设</h2>
              <p className="mr-muted">
                预设保留源分支顺序、合并策略和检查配置。运行时重新读取分支快照。
              </p>
              {!filteredPresets.length ? (
                <p className="mr-empty">
                  暂无预设。在新建 MR 时可保存当前配置。
                </p>
              ) : (
                filteredPresets.map((preset) => (
                  <article key={preset.id} className="mr-preset">
                    <div>
                      <h3>{preset.name}</h3>
                      <p>
                        {preset.input.sources.join(" → ")} →{" "}
                        <strong>{preset.input.target}</strong>
                      </p>
                      <p className="mr-muted">
                        {preset.input.strategy} ·{" "}
                        {preset.input.checks?.length ?? 0} 项检查 ·{" "}
                        {preset.input.autoFinalize
                          ? "检查通过后自动更新本地目标"
                          : "人工确认更新目标"}
                        {preset.input.allowCheckedOutTarget
                          ? " · 允许更新检出目标"
                          : ""}
                      </p>
                    </div>
                    <div className="mr-actions">
                      <button
                        className="mr-primary"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () =>
                            openRequest(
                              (await gitMrApi.runPreset(projectId, preset.id))
                                .id,
                            ),
                          )
                        }
                      >
                        <Play size={14} />
                        运行
                      </button>
                      <button
                        disabled={busy}
                        aria-label={`删除预设 ${preset.name}`}
                        onClick={() =>
                          void perform(() =>
                            gitMrApi.deletePreset(projectId, preset.id),
                          )
                        }
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </article>
                ))
              )}
            </section>
          )}
        </>
      )}
      {createOpen && (
        <MergeRequestForm
          projectId={projectId}
          roots={roots}
          rootId={rootId ?? ""}
          workspace={workspace}
          onRootChange={setRootId}
          onClose={() => setCreateOpen(false)}
          onSubmit={create}
        />
      )}
    </main>
  );
}
