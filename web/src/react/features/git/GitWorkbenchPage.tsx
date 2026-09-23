import { useCallback, useEffect, useState } from "react";
import {
  GitBranch,
  GitMerge,
  Plus,
  RefreshCw,
  Play,
  Trash2,
} from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
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
import { MergeRequestDetail } from "./MergeRequestDetail";
import { isTerminal, statusLabels } from "./mergeUi";
import "./gitWorkbench.css";
type View = "requests" | "branches" | "presets" | "history";
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
  const [view, setView] = useState<View>("requests");
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
    <main className="git-workbench">
      <header className="mr-page-header">
        <div>
          <h1>
            <GitMerge size={23} />
            Git 工作台
          </h1>
          <p className="mr-muted">在独立工作树中准备、审阅和验证本地合并。</p>
        </div>
        <div className="mr-actions">
          <button
            disabled={busy || loading}
            aria-label="刷新 Git 工作台"
            onClick={() =>
              void perform(async () => {
                setRefreshVersion((value) => value + 1);
              })
            }
          >
            <RefreshCw size={16} />
            刷新
          </button>
          <button
            className="mr-primary"
            disabled={loading || branchLoading || !workspace}
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={16} />
            新建 MR
          </button>
        </div>
      </header>
      <div className="mr-toolbar">
        <nav aria-label="Git 视图" className="mr-tabs">
          {(
            [
              ["requests", "合并请求"],
              ["branches", "分支"],
              ["presets", "预设"],
              ["history", "运行记录"],
            ] as [View, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              aria-current={view === id ? "page" : undefined}
              onClick={() => setView(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <label className="mr-root-select">
          仓库
          <select
            value={rootId ?? ""}
            onChange={(e) => setRootId(e.target.value)}
          >
            {!roots.length && <option value="">项目默认仓库</option>}
            {roots.map((root) => (
              <option
                key={root.id}
                value={root.id}
                disabled={root.status !== "available"}
              >
                {root.name}
              </option>
            ))}
          </select>
        </label>
      </div>
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
            <>
              {!filteredRequests.length ? (
                <div className="mr-empty">
                  <GitMerge size={32} />
                  <h2>还没有本地合并请求</h2>
                  <p>选择源分支与目标分支，在更新目标前审阅合并结果。</p>
                  <button
                    className="mr-primary"
                    disabled={!workspace}
                    onClick={() => setCreateOpen(true)}
                  >
                    创建第一个 MR
                  </button>
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
                            <GitMerge size={20} />
                            <div className="mr-request-text">
                              <strong>{mr.title}</strong>
                              <span>
                                {mr.steps
                                  .map((step) => step.branch)
                                  .join(" → ")}{" "}
                                → {mr.target}
                              </span>
                              <small>{mr.repository}</small>
                            </div>
                            <div className="mr-request-meta">
                              <span
                                className={`mr-status mr-status-${mr.status}`}
                              >
                                {statusLabels[mr.status]}
                              </span>
                              <time>
                                {new Date(mr.updatedAt).toLocaleString()}
                              </time>
                            </div>
                          </button>
                        ))}
                      </div>
                    </section>
                  ))
              )}
            </>
          )}
          {view === "branches" && (
            <section className="mr-card">
              <h2>本地分支</h2>
              {branchLoading ? (
                <p role="status">正在加载分支…</p>
              ) : !workspace ? (
                <p className="mr-empty">无法读取仓库分支。</p>
              ) : (
                <>
                  <p className="mr-muted mr-repo-path">
                    {workspace.repositoryRoot}
                  </p>
                  <div className="mr-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>分支</th>
                          <th>提交</th>
                          <th>上游</th>
                          <th>工作树 / 会话</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workspace.branches.map((branch) => {
                          const worktree = workspace.worktrees.find(
                            (item) => item.path === branch.checkedOutPath,
                          );
                          return (
                            <tr key={branch.name}>
                              <td>
                                <span className="mr-actions">
                                  <GitBranch size={15} />
                                  {branch.name}
                                </span>
                              </td>
                              <td>
                                <code title={branch.head}>
                                  {branch.head.slice(0, 12)}
                                </code>
                              </td>
                              <td>{branch.upstream ?? "—"}</td>
                              <td>
                                {branch.checkedOutPath ? (
                                  <>
                                    <code>{branch.checkedOutPath}</code>
                                    {worktree && (
                                      <small>
                                        {worktree.dirty
                                          ? "有未提交更改"
                                          : "干净"}{" "}
                                        · {worktree.sessionCount} 个会话
                                        {worktree.managed ? " · 托管" : ""}
                                      </small>
                                    )}
                                  </>
                                ) : (
                                  "未检出"
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
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
          {view === "history" && (
            <section className="mr-card">
              <h2>运行记录</h2>
              {!filteredRequests.length ? (
                <p className="mr-empty">暂无运行记录。</p>
              ) : (
                <ol className="mr-events">
                  {filteredRequests
                    .flatMap((mr) =>
                      mr.events.map((event, index) => ({
                        ...event,
                        mr,
                        index,
                      })),
                    )
                    .sort((a, b) => b.at.localeCompare(a.at))
                    .map((event) => (
                      <li key={`${event.mr.id}-${event.index}`}>
                        <time>{new Date(event.at).toLocaleString()}</time>
                        <button
                          className="mr-text-button"
                          onClick={() => openRequest(event.mr.id)}
                        >
                          {event.mr.title}
                        </button>
                        <span>{event.message}</span>
                      </li>
                    ))}
                </ol>
              )}
            </section>
          )}
        </>
      )}
      {createOpen && (
        <MergeRequestForm
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
