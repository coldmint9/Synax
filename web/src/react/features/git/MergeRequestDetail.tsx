import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, FileDiff, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  gitMrApi,
  type MergeRequest,
  type MergeFileSummary,
  type MergeFile,
  type MergeProposal,
  type MergeAction,
} from "../../../lib/api/gitMr";
import { FileViewerDialog } from "../../components/file-viewer/FileViewerDialog";
import { canFinalize, isRunning, isTerminal, statusLabels } from "./mergeUi";
export function MergeRequestDetail({
  projectId,
  mrId,
}: {
  projectId: string;
  mrId: string;
}) {
  const navigate = useNavigate();
  const [mr, setMr] = useState<MergeRequest | null>(null);
  const [files, setFiles] = useState<MergeFileSummary[]>([]);
  const [proposals, setProposals] = useState<MergeProposal[]>([]);
  const [file, setFile] = useState<MergeFile | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const request = await gitMrApi.get(projectId, mrId);
    if (current !== generation.current) return;
    setMr(request);
    const [nextFiles, nextProposals] = await Promise.all([
      gitMrApi.files(projectId, mrId),
      gitMrApi.proposals(projectId, mrId),
    ]);
    if (current !== generation.current) return;
    setFiles(nextFiles);
    setProposals(nextProposals);
  }, [projectId, mrId]);
  useEffect(() => {
    let active = true;
    refresh()
      .catch((err) => {
        if (active) setError(String(err.message ?? err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (!mr || !isRunning(mr.status) || busy) return;
    const timer = window.setInterval(() => {
      refresh().catch((err) => setError(String(err.message ?? err)));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [mr?.status, busy, refresh]);
  async function perform(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(
        `${err instanceof Error ? err.message : String(err)}。请刷新查看当前状态后重试。`,
      );
      await refresh().catch(() => {});
    } finally {
      setBusy("");
    }
  }
  function act(action: MergeAction) {
    if (!mr) return;
    setConfirmFinalize(false);
    void perform(action, async () => {
      setMr(await gitMrApi.action(projectId, mr.id, action, mr.version));
    });
  }
  const locked =
    !!busy || (!!mr && (isTerminal(mr.status) || isRunning(mr.status)));
  const conflictCount = files.filter((item) => item.conflicted).length;
  const basePath = `/projects/${encodeURIComponent(projectId)}/git`;
  if (loading && !mr)
    return (
      <div className="mr-empty" role="status">
        正在加载合并请求…
      </div>
    );
  return (
    <main className="git-workbench mr-detail">
      <header className="mr-page-header">
        <div className="mr-actions">
          <button onClick={() => navigate(basePath)}>
            <ArrowLeft size={16} />
            合并请求
          </button>
          {mr && (
            <span className={`mr-status mr-status-${mr.status}`}>
              {statusLabels[mr.status]}
            </span>
          )}
        </div>
        <button
          disabled={!!busy}
          onClick={() => void perform("refresh", async () => {})}
        >
          <RefreshCw size={15} />
          刷新
        </button>
      </header>
      {error && (
        <p role="alert" className="mr-error">
          {error}
        </p>
      )}
      {!mr ? (
        <div className="mr-empty">无法加载此合并请求。</div>
      ) : (
        <>
          <div className="mr-title-row">
            <div>
              <h1>{mr.title}</h1>
              <p className="mr-muted">
                <code>{mr.steps.map((step) => step.branch).join(" → ")}</code>{" "}
                合入 <strong>{mr.target}</strong> · {mr.strategy} · v
                {mr.version}
              </p>
              <p className="mr-muted mr-repo-path">{mr.repository}</p>
            </div>
            <button
              disabled={!!busy || isRunning(mr.status)}
              onClick={() =>
                void perform("agent", async () => {
                  const result = await gitMrApi.agentSession(projectId, mr.id);
                  navigate(
                    `/projects/${encodeURIComponent(projectId)}/sessions?session=${encodeURIComponent(result.sessionId)}`,
                  );
                })
              }
            >
              <Bot size={16} />
              {mr.agentSessionId ? "打开 Git Agent" : "请 Git Agent 协助"}
            </button>
          </div>
          {mr.error && (
            <p className="mr-error" role="alert">
              {mr.error}
            </p>
          )}
          {(["failed", "interrupted"] as string[]).includes(mr.status) && (
            <p className="mr-notice">
              本次执行保留了现场。恢复前会核对目标分支、候选工作树和执行记录；无法安全恢复时会保留现场并说明原因。
            </p>
          )}
          <section className="mr-card">
            <div className="mr-row">
              <h2>合并进度</h2>
              <span className="mr-muted">
                目标快照{" "}
                <code title={mr.targetOid}>{mr.targetOid.slice(0, 12)}</code>
              </span>
            </div>
            <ol className="mr-steps">
              {mr.steps.map((step, index) => (
                <li
                  key={`${step.branch}-${index}`}
                  data-current={index === mr.currentStep}
                >
                  <span className="mr-step-number">{index + 1}</span>
                  <div>
                    <strong>{step.branch}</strong>
                    <code title={step.oid}>{step.oid.slice(0, 12)}</code>
                  </div>
                  <span>
                    {
                      {
                        pending: "待评估",
                        merging: "合并中",
                        conflicted: "待解决冲突",
                        completed: "已完成",
                        noop: "无需变更",
                      }[step.status]
                    }
                  </span>
                </li>
              ))}
            </ol>
            <div className="mr-actions mr-wrap">
              {mr.status === "draft" && (
                <button
                  className="mr-primary"
                  disabled={!!busy}
                  onClick={() => act("prepare")}
                >
                  准备合并
                </button>
              )}
              {(["failed", "interrupted"] as string[]).includes(mr.status) && (
                <button
                  className="mr-primary"
                  disabled={!!busy}
                  onClick={() => act("resume")}
                >
                  核验并恢复
                </button>
              )}
              {mr.status === "conflicted" && (
                <button
                  className="mr-primary"
                  disabled={!!busy || conflictCount > 0}
                  onClick={() => act("continue")}
                >
                  {conflictCount
                    ? `还有 ${conflictCount} 个冲突待解决`
                    : "继续合并"}
                </button>
              )}
              {(["ready", "check_failed"] as string[]).includes(mr.status) && (
                <button disabled={!!busy} onClick={() => act("checks")}>
                  {mr.checkResults.length ? "重新运行检查" : "运行检查"}
                </button>
              )}
              {mr.status === "ready" && (
                <button
                  className="mr-primary"
                  disabled={!!busy || !canFinalize(mr)}
                  onClick={() => setConfirmFinalize(true)}
                >
                  更新本地目标
                </button>
              )}
              {!isTerminal(mr.status) && (
                <button
                  disabled={!!busy || isRunning(mr.status)}
                  onClick={() => act("cancel")}
                >
                  取消 MR
                </button>
              )}
              {busy && (
                <span role="status" className="mr-muted">
                  正在处理…
                </span>
              )}
              {isRunning(mr.status) && (
                <span role="status" className="mr-muted">
                  {statusLabels[mr.status]}，状态会自动刷新
                </span>
              )}
            </div>
            {mr.status === "ready" && !canFinalize(mr) && (
              <p className="mr-muted">
                全部检查必须针对当前候选内容通过，才能更新目标。
              </p>
            )}
            {isTerminal(mr.status) && (
              <p className="mr-muted">
                {mr.status === "merged"
                  ? "本地目标已更新。"
                  : statusLabels[mr.status]}{" "}
                此操作不推送远端或删除源分支。
              </p>
            )}
            {confirmFinalize && (
              <div
                className="mr-confirm"
                role="group"
                aria-label="确认更新目标"
              >
                <p>
                  将 <strong>{mr.target}</strong> 从{" "}
                  <code>{mr.targetOid.slice(0, 12)}</code> 更新为候选提交{" "}
                  <code>{mr.candidateOid?.slice(0, 12)}</code>。
                  {mr.allowCheckedOutTarget && " 已授权更新检出的目标工作树。"}
                </p>
                <div className="mr-actions">
                  <button onClick={() => setConfirmFinalize(false)}>
                    返回检查
                  </button>
                  <button
                    className="mr-primary"
                    disabled={!!busy}
                    onClick={() => act("finalize")}
                  >
                    确认更新本地 {mr.target}
                  </button>
                </div>
              </div>
            )}
          </section>
          <div className="mr-detail-columns">
            <section className="mr-card">
              <div className="mr-row">
                <h2>
                  文件变更 <span className="mr-muted">{files.length}</span>
                </h2>
                {conflictCount > 0 && (
                  <span className="mr-status mr-status-conflicted">
                    {conflictCount} 个冲突
                  </span>
                )}
              </div>
              <p className="mr-muted">
                目标 / 累计结果：{mr.target} · 当前源：
                {mr.steps[mr.currentStep]?.branch ?? "全部完成"}
              </p>
              {!files.length ? (
                <p className="mr-empty">
                  {mr.status === "draft"
                    ? "准备合并后查看文件变更。"
                    : "没有可显示的文件变更。"}
                </p>
              ) : (
                <ul className="mr-file-list">
                  {files.map((item) => (
                    <li key={item.id}>
                      <button
                        disabled={!!busy}
                        onClick={() =>
                          void perform("file", async () =>
                            setFile(
                              await gitMrApi.file(projectId, mr.id, item.id),
                            ),
                          )
                        }
                      >
                        <FileDiff size={16} />
                        <span>{item.path}</span>
                        <span
                          className={
                            item.conflicted ? "mr-conflict-label" : "mr-muted"
                          }
                        >
                          {item.conflicted ? "冲突" : item.status}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="mr-card">
              <h2>验证结果</h2>
              {!mr.checks.length ? (
                <p className="mr-muted">未配置检查。完成前请审阅候选变更。</p>
              ) : (
                mr.checks.map((check) => {
                  const result = [...mr.checkResults]
                    .reverse()
                    .find((item) => item.id === check.id);
                  const stale = result && result.tree !== mr.candidateTree;
                  return (
                    <details className="mr-check-result" key={check.id}>
                      <summary>
                        <code>
                          {check.executable} {check.args.join(" ")}
                        </code>
                        <span>
                          {!result
                            ? "待运行"
                            : stale
                              ? "已过期，需要重跑"
                              : result.status === "passed"
                                ? "通过"
                                : "失败"}
                        </span>
                      </summary>
                      {result && (
                        <>
                          <p className="mr-muted">
                            {new Date(result.finishedAt).toLocaleString()} ·{" "}
                            {result.tree.slice(0, 12)}
                          </p>
                          <pre>{result.output || "（无输出）"}</pre>
                        </>
                      )}
                    </details>
                  );
                })
              )}
            </section>
          </div>
          {proposals.length > 0 && (
            <section className="mr-card">
              <h2>Git Agent 提案</h2>
              <p className="mr-muted">
                采纳将修改候选文件；服务端会校验提案的文件版本。采纳后仍需审阅、解决冲突和重新检查。
              </p>
              {proposals.map((proposal) => (
                <details className="mr-proposal" key={proposal.id}>
                  <summary>
                    {files.find((item) => item.id === proposal.fileId)?.path ??
                      proposal.fileId}{" "}
                    · {proposal.rationale}
                  </summary>
                  <pre>{proposal.content}</pre>
                  <button
                    disabled={locked}
                    onClick={() =>
                      void perform("proposal", async () =>
                        setFile(
                          await gitMrApi.applyProposal(
                            projectId,
                            mr.id,
                            proposal.id,
                            mr.version,
                          ),
                        ),
                      )
                    }
                  >
                    采纳此提案并审阅
                  </button>
                </details>
              ))}
            </section>
          )}
          <section className="mr-card">
            <h2>运行记录</h2>
            <ol className="mr-events">
              {mr.events.map((event, index) => (
                <li key={`${event.at}-${index}`}>
                  <time>{new Date(event.at).toLocaleString()}</time>
                  <span>{event.message}</span>
                </li>
              ))}
            </ol>
          </section>
          {file && (
            <FileViewerDialog
              file={file}
              readOnly={
                locked || mr.status !== "conflicted" || !file.conflicted
              }
              onClose={() => setFile(null)}
              onSave={async (input) => {
                const updated = await gitMrApi.saveFile(
                  projectId,
                  mr.id,
                  file.id,
                  input,
                );
                setFile(updated);
                // A successful write remains successful even if refreshing the MR fails.
                // In particular, keep a draft buffer and its new revision mounted.
                await refresh().catch((cause) => {
                  setError(
                    `文件已保存，但状态刷新失败：${cause instanceof Error ? cause.message : String(cause)}。请刷新后继续操作。`,
                  );
                });
              }}
            />
          )}
        </>
      )}
    </main>
  );
}
