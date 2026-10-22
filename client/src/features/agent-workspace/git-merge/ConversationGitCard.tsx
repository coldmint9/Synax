import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  FileDiff,
  GitBranch,
  GitMerge,
  LoaderCircle,
  Maximize2,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import type { MergeFile } from "../../../adapters/transport/gitMr";
import {
  conversationGitApi,
  type ConversationGitReference,
  type ConversationGitSnapshot,
} from "../../../adapters/transport/conversationGit";
import { useTranscriptSession } from "../SessionTranscriptContext";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { refreshWorkspace } from "../workspaceRefresh";
import { Button } from "../../../shared/ui/ui/Button";
import { Checkbox } from "../../../shared/ui/ui/Toggle";
import { Dialog, DialogPanel, DialogTitle } from "../../../shared/ui/ui/Dialog";
import { FileViewerDialog } from "../../../shared/ui/file-viewer/FileViewerDialog";
import { taskPresentation } from "./model";
import { CommitGraph } from "./CommitGraph";
import { ConflictPreview } from "./ConflictPreview";
import "./conversationGit.css";

function newRequestId() {
  return crypto.randomUUID();
}
function statusTone(
  status: ConversationGitSnapshot["mr"]["status"],
  stale: boolean,
) {
  if (
    stale ||
    status === "conflicted" ||
    status === "check_failed" ||
    status === "failed"
  )
    return "warning";
  if (status === "merged" || status === "ready" || status === "noop")
    return "success";
  return "neutral";
}

export function ConversationGitCard({
  reference,
  readOnly = false,
}: {
  reference: ConversationGitReference;
  readOnly?: boolean;
}) {
  const scope = useTranscriptSession();
  const owner = scope.sessionId === reference.sessionId;
  const ingestMessages = useAgentSessionStore(
    (state) => state.ingestConversationMessages,
  );
  const submitInput = useAgentSessionStore(
    (state) => state.submitOrEnqueueSessionInput,
  );
  const [snapshot, setSnapshot] = useState<ConversationGitSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [file, setFile] = useState<MergeFile | null>(null);
  const [previewFile, setPreviewFile] = useState<MergeFile | null>(null);
  const [appliedProposalId, setAppliedProposalId] = useState<string>();
  const [focused, setFocused] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState("");
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [skipChecks, setSkipChecks] = useState(false);
  const generation = useRef(0);
  const loadingRequest = useRef(false);
  const activeMutation = useRef("");
  const mounted = useRef(true);
  const currentSnapshot = useRef(snapshot);
  currentSnapshot.current = snapshot;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (silent = false) => {
      if (!owner) {
        setLoading(false);
        return;
      }
      if (silent && loadingRequest.current) return;
      loadingRequest.current = true;
      const current = ++generation.current;
      if (!silent) setLoading(true);
      try {
        const next = await conversationGitApi.get(
          reference.sessionId,
          reference.objectId,
        );
        if (current !== generation.current || !mounted.current) return;
        if (
          next.task.id !== reference.objectId ||
          next.task.sessionId !== reference.sessionId ||
          next.task.projectId !== reference.projectId
        )
          throw new Error("任务响应与当前会话不匹配。");
        setSnapshot((previous) =>
          !previous ||
          next.task.revision > previous.task.revision ||
          (next.task.revision === previous.task.revision &&
            next.mr.version >= previous.mr.version)
            ? next
            : previous,
        );
        if (!silent) setError("");
      } catch (cause) {
        if (current === generation.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        loadingRequest.current = false;
        if (mounted.current && current === generation.current && !silent)
          setLoading(false);
      }
    },
    [owner, reference.objectId, reference.projectId, reference.sessionId],
  );

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    if (
      !snapshot ||
      readOnly ||
      !owner ||
      snapshot.mr.status === "merged" ||
      snapshot.mr.status === "noop" ||
      snapshot.mr.status === "cancelled"
    )
      return;
    const running =
      !!busy ||
      ["preparing", "checking", "applying"].includes(snapshot.mr.status);
    const timer = window.setInterval(
      () => {
        if (document.visibilityState !== "hidden") void load(true);
      },
      running ? 1100 : 5000,
    );
    return () => window.clearInterval(timer);
  }, [load, snapshot?.mr.status, busy, owner, readOnly]);

  const presentation = snapshot ? taskPresentation(snapshot) : null;
  const mutate = useCallback(
    async (label: string, action: () => Promise<ConversationGitSnapshot>) => {
      if (
        !snapshot ||
        readOnly ||
        !owner ||
        (activeMutation.current &&
          !(label === "cancel" && snapshot.mr.status === "checking"))
      )
        return;
      activeMutation.current = label;
      generation.current++;
      setBusy(label);
      setError("");
      setConfirmFinalize(false);
      try {
        const next = await action();
        if (!mounted.current) return;
        generation.current++;
        const previous = currentSnapshot.current;
        if (
          !previous ||
          next.task.revision > previous.task.revision ||
          (next.task.revision === previous.task.revision &&
            next.mr.version >= previous.mr.version)
        )
          setSnapshot(next);
        if (
          next.task.revision !== snapshot.task.revision ||
          next.task.mrId !== snapshot.task.mrId
        ) {
          setPreviewFile(null);
          setFile(null);
        }
        refreshWorkspace(reference.sessionId, reference.rootId);
        ingestMessages(reference.sessionId, next.messages);
        return next;
      } catch (cause) {
        if (!mounted.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        await load(true);
      } finally {
        if (activeMutation.current === label) activeMutation.current = "";
        if (mounted.current)
          setBusy((current) => (current === label ? "" : current));
      }
    },
    [
      ingestMessages,
      busy,
      load,
      owner,
      readOnly,
      reference.rootId,
      reference.sessionId,
      snapshot,
    ],
  );

  if (!owner)
    return (
      <section
        className="conversation-git-card conversation-git-card--scope"
        aria-label="Git合并任务"
      >
        <CircleAlert size={15} />
        <span>此任务属于另一个会话。切换到任务所属会话后才能操作。</span>
      </section>
    );
  if (loading && !snapshot)
    return (
      <section className="conversation-git-card" role="status">
        <LoaderCircle className="conversation-git-spin" size={15} />
        正在加载合并任务…
      </section>
    );
  if (!snapshot || !presentation)
    return (
      <section className="conversation-git-card" role="alert">
        <CircleAlert size={15} />
        {error || "合并任务不可用。"}
        <Button size="xs" onClick={() => void load()}>
          重试
        </Button>
      </section>
    );

  const { mr } = snapshot;
  const tone = statusTone(mr.status, snapshot.stale);
  const canWrite = !readOnly && !busy && !snapshot.stale;
  const hasChecks = mr.checks.length > 0;
  const runLabel =
    mr.status === "draft"
      ? "开始分析"
      : mr.status === "conflicted"
        ? `继续合并${presentation.conflicts ? ` · 还有 ${presentation.conflicts} 个冲突` : ""}`
        : mr.status === "check_failed"
          ? "重新运行检查"
          : "";
  const doAction = (
    action:
      | "prepare"
      | "continue"
      | "checks"
      | "cancel"
      | "resume"
      | "finalize"
      | "replan",
    skip = false,
  ) =>
    mutate(action, () =>
      conversationGitApi.action(reference.sessionId, reference.objectId, {
        action,
        requestId: newRequestId(),
        expectedVersion: mr.version,
        expectedTaskRevision: snapshot.task.revision,
        ...(action === "finalize" && skip ? { skipChecks: true } : {}),
      }),
    );
  const openFile = async (id: string) => {
    if (activeMutation.current) return;
    activeMutation.current = `file:${id}`;
    setBusy(`file:${id}`);
    setError("");
    try {
      setPreviewFile(
        await conversationGitApi.file(
          reference.sessionId,
          reference.objectId,
          id,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      activeMutation.current = "";
      if (mounted.current) setBusy("");
    }
  };
  const saveFile = async (
    input: Parameters<
      NonNullable<ComponentProps<typeof FileViewerDialog>["onSave"]>
    >[0],
    selected = file ?? previewFile,
  ) => {
    if (!selected || !snapshot || readOnly || !owner || snapshot.stale)
      throw new Error("当前任务不可修改。");
    generation.current++;
    const next = await conversationGitApi.saveFile(
      reference.sessionId,
      reference.objectId,
      selected.id,
      {
        ...input,
        expectedVersion: snapshot.mr.version,
        expectedTaskRevision: snapshot.task.revision,
        requestId: newRequestId(),
      },
    );
    generation.current++;
    setSnapshot(next);
    refreshWorkspace(reference.sessionId, reference.rootId);
    ingestMessages(reference.sessionId, next.messages);
    try {
      const updated = await conversationGitApi.file(
        reference.sessionId,
        reference.objectId,
        selected.id,
      );
      setPreviewFile(updated);
      if (!input.resolve && file?.id === selected.id) setFile(updated);
    } catch {
      setPreviewFile(null);
      setFile(null);
      setError("文件已保存，最新预览暂时无法读取，请重新打开文件后继续。");
    }
  };
  const saveInline = async (input: Parameters<typeof saveFile>[0]) => {
    if (!previewFile || activeMutation.current) return;
    activeMutation.current = "save";
    setBusy("save");
    setError("");
    try {
      await saveFile(input, previewFile);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await load(true);
    } finally {
      activeMutation.current = "";
      if (mounted.current) setBusy("");
    }
  };
  const applyProposal = async (proposalId: string) => {
    const next = await mutate("proposal", () =>
      conversationGitApi.applyProposal(
        reference.sessionId,
        reference.objectId,
        {
          proposalId,
          expectedVersion: mr.version,
          expectedTaskRevision: snapshot.task.revision,
          requestId: newRequestId(),
        },
      ),
    );
    if (next && previewFile) {
      setAppliedProposalId(proposalId);
      await openFile(previewFile.id);
    }
  };
  const assistantPrompt = (text: string) => {
    if (!owner || readOnly) return;
    void submitInput(reference.sessionId, {
      message: `${text}\n任务对象：${reference.objectId}`,
      prompt: `${text}\n请只修改当前 Git 合并任务对象 ${reference.objectId}，不要创建新的合并任务。`,
      messageSource: "system_injection",
    }).catch((cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  const content = (
    <section
      className={`conversation-git-card conversation-git-card--${tone} ${focused ? "is-focused" : ""}`}
      aria-label={`Git合并任务：${reference.title}`}
      aria-busy={presentation.running || !!busy}
      data-object-id={reference.objectId}
    >
      <header className="conversation-git-card__header">
        <div className="conversation-git-card__title">
          <span className="conversation-git-card__icon">
            <GitPullRequestIcon />
          </span>
          <div>
            <h3>{reference.title}</h3>
            <p>
              <code>{mr.steps.map((step) => step.branch).join(" + ")}</code>
              <ArrowRight size={12} />
              <code>{mr.target}</code>
            </p>
          </div>
        </div>
        <div className="conversation-git-card__header-actions">
          <span
            className={`conversation-git-status conversation-git-status--${tone}`}
            role="status"
            aria-live="polite"
          >
            <i />
            {snapshot.stale ? "需要重新分析" : presentation.status}
          </span>
          <button
            className="conversation-git-icon-button"
            aria-label={focused ? "退出专注视图" : "展开专注视图"}
            onClick={() => setFocused(!focused)}
          >
            <Maximize2 size={14} />
          </button>
          <button
            className="conversation-git-icon-button"
            aria-label={collapsed ? "展开合并任务" : "折叠合并任务"}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
        </div>
      </header>
      {!collapsed && (
        <>
          <CommitGraph
            commits={snapshot.commits}
            pendingMerge={
              !presentation.terminal && !snapshot.stale
                ? {
                    key: mr.id,
                    target: mr.target,
                    sources: mr.steps.map((step) => step.branch),
                    parents: [
                      mr.targetOid,
                      ...mr.steps.map((step) => step.oid),
                    ],
                    candidateOid: mr.candidateOid,
                  }
                : undefined
            }
            animate={!readOnly}
          />
          {(snapshot.stale ||
            mr.status === "conflicted" ||
            (mr.status !== "draft" && snapshot.files.length > 0)) && (
            <section className="conversation-git-files">
              <div className="conversation-git-section-heading">
                <div>
                  <FileDiff size={14} />
                  <strong>
                    {snapshot.stale
                      ? "基线发生变化"
                      : mr.status === "conflicted"
                        ? "需要确认的冲突"
                        : "已锁定的解决方案"}
                  </strong>
                  <span>{presentation.conflicts} 个冲突</span>
                </div>
                <span className="conversation-git-readonly-label">
                  {snapshot.stale || mr.status !== "conflicted"
                    ? "只读·点击回看"
                    : "可编辑"}
                </span>
              </div>
              {snapshot.stale ? (
                <div className="conversation-git-stale">
                  <p>
                    {snapshot.staleReason ||
                      "目标或来源分支已移动，旧候选不能继续发布。"}
                  </p>
                  <Button
                    size="sm"
                    disabled={readOnly || !!busy || presentation.running}
                    onClick={() => doAction("replan")}
                  >
                    <RefreshCw size={13} />
                    重新分析
                  </Button>
                </div>
              ) : (
                snapshot.files.map((item) => (
                  <div key={item.id}>
                    <button
                      className="conversation-git-file-row"
                      onClick={() =>
                        previewFile?.id === item.id
                          ? setPreviewFile(null)
                          : void openFile(item.id)
                      }
                      disabled={!!busy}
                    >
                      <Code2 size={14} />
                      <span>{item.path}</span>
                      <span
                        className={
                          item.conflicted ? "is-conflicted" : "is-resolved"
                        }
                      >
                        {item.conflicted ? "冲突" : "已解决"}
                      </span>
                      <ChevronRight size={13} />
                    </button>
                    {previewFile?.id === item.id && (
                      <ConflictPreview
                        file={previewFile}
                        mr={mr}
                        proposals={snapshot.proposals}
                        appliedProposalId={appliedProposalId}
                        blocked={!canWrite || presentation.running}
                        onSave={(input) => void saveInline(input)}
                        onEdit={() => setFile(previewFile)}
                        onApplyProposal={(proposal) =>
                          void applyProposal(proposal.id)
                        }
                        onAsk={() =>
                          assistantPrompt(
                            `请读取当前任务文件 ${item.path}（fileId=${item.id}），为冲突生成或修改有理由的解决建议，保存提案供我审阅，不要应用或合并。`,
                          )
                        }
                      />
                    )}
                  </div>
                ))
              )}
            </section>
          )}
          {mr.error && mr.status !== "check_failed" && (
            <p className="conversation-git-inline-error" role="alert">
              {mr.error}
            </p>
          )}
          {mr.status === "check_failed" && (
            <div className="conversation-git-error" role="alert">
              <CircleAlert size={14} />
              <div>
                <strong>检查未通过</strong>
                <span>
                  {mr.checkResults
                    .filter((item) => item.status === "failed")
                    .map((item) => item.output)
                    .join("\n") ||
                    mr.error ||
                    "候选内容需要修复后重试。"}
                </span>
              </div>
            </div>
          )}
          {mr.checks.length > 0 && (
            <section className="conversation-git-checks">
              <div className="conversation-git-section-heading">
                <div>
                  <CheckCircle2 size={14} />
                  <strong>验证检查</strong>
                  <span>
                    {presentation.passed}/{mr.checks.length} 通过
                  </span>
                </div>
                <span>{mr.status === "checking" ? "运行中…" : "真实命令"}</span>
              </div>
              {presentation.results.map(({ check, result, current }) => (
                <details key={check.id}>
                  <summary>
                    <strong>{check.id}</strong>
                    <span>
                      {!result
                        ? "待运行"
                        : !current
                          ? "已过期"
                          : result.status === "passed"
                            ? "通过"
                            : "失败"}
                    </span>
                  </summary>
                  <p className="conversation-git-check-command">
                    <code>
                      {check.executable} {check.args.join(" ")}
                    </code>
                    <span>{check.timeoutMs.toLocaleString()} ms timeout</span>
                  </p>
                  {result && <pre>{result.output || "（无输出）"}</pre>}
                </details>
              ))}
            </section>
          )}
          {!hasChecks && ["ready", "check_failed"].includes(mr.status) && (
            <p className="conversation-git-no-checks">
              <CircleAlert size={14} />
              未配置验证检查。请审阅候选变更，再明确确认跳过检查后更新目标。
            </p>
          )}
          {mr.skippedChecks && (
            <p className="conversation-git-no-checks">已由用户明确跳过验证。</p>
          )}
          {presentation.complete && (
            <div className="conversation-git-receipt">
              <GitMerge size={18} />
              <div>
                <strong>
                  {mr.status === "noop"
                    ? "分支已经包含这些变更"
                    : `已合并到 ${mr.target}`}
                </strong>
                <span>
                  候选提交{" "}
                  <code>
                    {mr.candidateOid?.slice(0, 12) ?? mr.targetOid.slice(0, 12)}
                  </code>{" "}
                  · 操作已保存到对话
                </span>
              </div>
            </div>
          )}
          {mr.events.length > 0 && (
            <details className="conversation-git-events">
              <summary>操作记录 · {mr.events.length} 条</summary>
              <ol>
                {mr.events.map((event, index) => (
                  <li key={`${event.at}:${index}`}>
                    <time>{new Date(event.at).toLocaleString()}</time>
                    <span>{event.message}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
          <footer className="conversation-git-footer">
            <div className="conversation-git-footer-status">
              {presentation.running && (
                <LoaderCircle className="conversation-git-spin" size={14} />
              )}
              {mr.status === "draft"
                ? "尚未创建候选工作树"
                : mr.status === "conflicted"
                  ? `${presentation.conflicts} 个文件待解决`
                  : mr.status === "merged"
                    ? "已更新目标分支 · 不推送远端"
                    : mr.status === "ready"
                      ? hasChecks
                        ? presentation.passed === mr.checks.length
                          ? "检查通过，等待确认合并"
                          : "候选已准备，可验证或跳过验证后合并"
                        : "候选已准备，等待跳过检查的确认"
                      : presentation.status}
            </div>
            <div className="conversation-git-actions">
              {runLabel && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={
                    !canWrite ||
                    (mr.status === "conflicted" && presentation.conflicts > 0)
                  }
                  onClick={() =>
                    doAction(
                      mr.status === "draft"
                        ? "prepare"
                        : mr.status === "conflicted"
                          ? "continue"
                          : "checks",
                    )
                  }
                >
                  {presentation.running && (
                    <LoaderCircle className="conversation-git-spin" size={13} />
                  )}
                  {runLabel}
                </Button>
              )}
              {mr.status === "ready" && hasChecks && (
                <Button
                  size="sm"
                  disabled={!canWrite}
                  onClick={() => doAction("checks")}
                >
                  {mr.checkResults.length ? "重新运行检查" : "运行检查"}
                </Button>
              )}
              {["failed", "interrupted"].includes(mr.status) &&
                !snapshot.stale && (
                  <Button
                    size="sm"
                    disabled={readOnly || !!busy}
                    onClick={() => doAction("resume")}
                  >
                    <RotateCcw size={13} />
                    核验并恢复
                  </Button>
                )}
              {["ready", "check_failed"].includes(mr.status) && hasChecks && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!canWrite}
                  onClick={() => {
                    setSkipChecks(false);
                    setConfirmFinalize(true);
                  }}
                >
                  <GitMerge size={13} />
                  确认更新 {mr.target}
                </Button>
              )}
              {mr.status === "ready" && !hasChecks && (
                <Button
                  size="sm"
                  disabled={!canWrite}
                  onClick={() => {
                    setSkipChecks(false);
                    setConfirmFinalize(true);
                  }}
                >
                  确认跳过检查
                </Button>
              )}
              {!["merged", "noop", "cancelled"].includes(mr.status) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={
                    readOnly ||
                    busy === "cancel" ||
                    (!!busy && mr.status !== "checking") ||
                    ["preparing", "applying"].includes(mr.status)
                  }
                  onClick={() => doAction("cancel")}
                >
                  <X size={13} />
                  取消
                </Button>
              )}
            </div>
          </footer>
          {error && (
            <div className="conversation-git-inline-error" role="alert">
              <span>{error}</span>
              <Button size="xs" variant="ghost" onClick={() => void load()}>
                刷新状态
              </Button>
            </div>
          )}
        </>
      )}
      {collapsed && (
        <button
          className="conversation-git-collapsed"
          onClick={() => setCollapsed(false)}
        >
          <GitMerge size={14} />
          {presentation.status} · {snapshot.files.length} 个文件
          <span>
            展开 <ChevronDown size={13} />
          </span>
        </button>
      )}
      <div className="conversation-git-caption">
        <span>
          <i />
          {readOnly ? "历史回看 · 只读" : "当前合并任务"}
          {snapshot.task.previousMrIds.length > 0 &&
            ` · 已重新分析 ${snapshot.task.previousMrIds.length} 次`}
        </span>
        <span>目标：{mr.target}</span>
      </div>
    </section>
  );
  return (
    <>
      {focused ? (
        <button
          className="conversation-git-focus-return"
          onClick={() => setFocused(false)}
        >
          <GitMerge size={14} />
          合并任务正在专注视图中显示
          <ArrowRight size={13} />
        </button>
      ) : (
        content
      )}
      {focused && (
        <Dialog open onClose={() => setFocused(false)}>
          <DialogPanel className="conversation-git-dialog">
            <div className="conversation-git-focus-header">
              <DialogTitle>{reference.title}</DialogTitle>
              <Button
                iconOnly
                size="sm"
                variant="ghost"
                aria-label="关闭专注视图"
                onClick={() => setFocused(false)}
              >
                <X size={15} />
              </Button>
            </div>
            <div className="conversation-git-focus-body">{content}</div>
          </DialogPanel>
        </Dialog>
      )}
      {confirmFinalize && (
        <Dialog open onClose={() => setConfirmFinalize(false)}>
          <DialogPanel className="conversation-git-confirm">
            <DialogTitle>确认更新 {mr.target}</DialogTitle>
            <p>
              {!hasChecks && (
                <strong>本任务没有配置检查，本次确认将跳过验证。 </strong>
              )}
              将候选提交 <code>{mr.candidateOid?.slice(0, 12)}</code> 更新到本地{" "}
              <strong>{mr.target}</strong>。服务端会再次检查分支版本与候选树。
            </p>
            {hasChecks && !presentation.canFinalize && (
              <label className="conversation-git-skip-confirm">
                <Checkbox checked={skipChecks} onChange={setSkipChecks} />
                跳过验证检查，我已审阅候选改动
              </label>
            )}
            <div>
              <Button onClick={() => setConfirmFinalize(false)}>
                返回检查
              </Button>
              <Button
                variant="primary"
                disabled={
                  !canWrite ||
                  (hasChecks && !presentation.canFinalize && !skipChecks)
                }
                onClick={() => doAction("finalize", skipChecks)}
              >
                确认更新本地 {mr.target}
              </Button>
            </div>
          </DialogPanel>
        </Dialog>
      )}
      {file && (
        <FileViewerDialog
          file={file}
          readOnly={
            readOnly ||
            snapshot.stale ||
            mr.status !== "conflicted" ||
            !file.conflicted ||
            !!busy
          }
          onClose={() => setFile(null)}
          onSave={saveFile}
        />
      )}
    </>
  );
}
function GitPullRequestIcon() {
  return <GitBranch size={18} />;
}

export default ConversationGitCard;
