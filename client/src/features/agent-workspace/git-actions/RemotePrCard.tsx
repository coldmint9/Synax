import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import {
  remotePrApi,
  type RemotePrAction,
  type RemotePrReference,
  type RemotePrSnapshot,
} from "../../../adapters/transport/remotePr";
import { Button } from "../../../shared/ui/ui/Button";
import {
  Dialog,
  DialogContainer,
  DialogPanel,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "../../../shared/ui/ui/Dialog";
import { VirtualList } from "../git-merge/VirtualList";
import { Select } from "../../../shared/ui/ui/Select";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useTranscriptSession } from "../SessionTranscriptContext";
import { refreshWorkspace } from "../workspaceRefresh";
import "../git-merge/conversationGit.css";
import "./gitActions.css";
const actionNames: Record<RemotePrAction["action"], string> = {
  merge: "确认远程合并",
  update_branch: "更新远程来源分支",
  sync_local: "快进同步到本地",
  resolve_conflicts: "在隔离工作树解决冲突",
  publish_resolution: "推送解决结果到远程",
};
export default function RemotePrCard({
  reference,
  readOnly = false,
}: {
  reference: RemotePrReference;
  readOnly?: boolean;
}) {
  const { sessionId } = useTranscriptSession();
  const [snapshot, setSnapshot] = useState<RemotePrSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<RemotePrAction["action"] | null>(null);
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("merge");
  const [generation] = useState(() => ({ current: 0 }));
  const mounted = useRef(true);
  const readController = useRef<AbortController | null>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (readController.current && !readController.current.signal.aborted)
        return;
      const controller = new AbortController();
      readController.current = controller;
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const version = ++generation.current;
      try {
        const result = await remotePrApi.get(
          reference.sessionId,
          reference.objectId,
          controller.signal,
        );
        if (
          result.task.id !== reference.objectId ||
          result.task.sessionId !== reference.sessionId ||
          result.task.projectId !== reference.projectId
        )
          throw new Error("远程任务响应与当前会话不匹配。");
        if (
          mounted.current &&
          version === generation.current &&
          !controller.signal.aborted
        ) {
          setSnapshot(result);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        if (readController.current === controller)
          readController.current = null;
      }
    },
    [reference.objectId, reference.sessionId, generation],
  );
  useEffect(() => {
    mounted.current = true;
    if (sessionId && sessionId !== reference.sessionId) return;
    const controller = new AbortController();
    void load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => {
      mounted.current = false;
      generation.current++;
      controller.abort();
      readController.current?.abort();
    };
  }, [load, sessionId, reference.sessionId, generation]);
  useEffect(() => {
    if (!snapshot || snapshot.pr.state !== "open" || readOnly || busy) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden")
        void load().catch((e) => {
          if (mounted.current) setError(e.message);
        });
    }, 15000);
    return () => clearInterval(timer);
  }, [snapshot?.pr.state, load, readOnly, busy]);
  const perform = async () => {
    if (
      !snapshot ||
      !pending ||
      busy ||
      readOnly ||
      sessionId !== reference.sessionId
    )
      return;
    const action = pending;
    readController.current?.abort();
    generation.current++;
    setBusy(true);
    setError("");
    try {
      const result = await remotePrApi.action(
        reference.sessionId,
        reference.objectId,
        {
          action,
          requestId: crypto.randomUUID(),
          expectedRevision: snapshot.task.revision,
          expectedHeadSha: snapshot.pr.headSha,
          expectedBaseSha: snapshot.pr.baseSha,
          ...(action === "merge" ? { mergeMethod: method } : {}),
        },
      );
      generation.current++;
      if (mounted.current) setSnapshot(result);
      useAgentSessionStore
        .getState()
        .ingestConversationMessages(reference.sessionId, result.messages);
      refreshWorkspace(reference.sessionId, reference.rootId);
      if (mounted.current) setPending(null);
      if (result.resolutionReference) {
        const { conversationGitApi } =
          await import("../../../adapters/transport/conversationGit");
        const local = await conversationGitApi.get(
          reference.sessionId,
          result.resolutionReference.objectId,
        );
        useAgentSessionStore
          .getState()
          .ingestConversationMessages(reference.sessionId, local.messages);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!mounted.current) return;
      try {
        await load();
      } catch {
        /* keep action error */
      }
      setError(message);
      setPending(null);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  if (sessionId && sessionId !== reference.sessionId) return null;
  if (!snapshot)
    return (
      <section className="conversation-git-card p-4" role="status">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Button
              size="sm"
              onClick={() => void load().catch((e) => setError(e.message))}
            >
              重试
            </Button>
          </>
        ) : (
          <>正在读取远程 PR / MR…</>
        )}
      </section>
    );
  const { pr, task, local } = snapshot;
  const writable = !readOnly && sessionId === reference.sessionId && !busy;
  const ready = pr.state === "open" && !pr.draft;
  const canMerge =
    ready &&
    pr.mergeable === true &&
    !pr.checksError &&
    pr.checks.every((check) => check.status === "passed");
  const platform =
    task.repository.provider === "github" ? "GitHub PR" : "GitLab MR";
  return (
    <>
      <section
        className="conversation-git-card conversation-git-card--window"
        aria-label={`${platform} #${pr.number}`}
        data-object-id={reference.objectId}
      >
        <header className="conversation-git-card__header">
          <div className="conversation-git-card__title">
            <span className="conversation-git-card__icon">
              <GitPullRequest size={18} />
            </span>
            <div>
              <h3>
                {pr.title} <small>#{pr.number}</small>
              </h3>
              <p>
                <code>{pr.head}</code>
                <ArrowRight size={12} />
                <code>{pr.base}</code>
              </p>
            </div>
          </div>
          <div className="conversation-git-card__header-actions">
            <span role="status">
              {pr.state === "merged"
                ? "已合并"
                : pr.state === "closed"
                  ? "已关闭"
                  : pr.draft
                    ? "草稿"
                    : pr.mergeable === false
                      ? "存在冲突"
                      : "开放中"}
            </span>
            <Button
              iconOnly
              size="sm"
              variant="ghost"
              aria-label="刷新远程 PR"
              disabled={busy}
              onClick={() => {
                setError("");
                void load().catch((e) => {
                  if (mounted.current) setError(e.message);
                });
              }}
            >
              <RefreshCw size={14} />
            </Button>
          </div>
        </header>
        <div
          className="conversation-git-body"
          role="region"
          aria-label="远程请求内容"
          tabIndex={0}
        >
          <div className="remote-pr-meta">
            <span>
              {platform} · {task.repository.host}/{task.repository.path}
            </span>
            {pr.url && (
              <a href={pr.url} target="_blank" rel="noreferrer">
                在平台打开
                <ArrowUpRight size={12} />
              </a>
            )}
          </div>
          <div className="remote-pr-summary">
            <div>
              <span>来源提交</span>
              <code>{pr.headSha.slice(0, 12)}</code>
            </div>
            <div>
              <span>目标提交</span>
              <code>{pr.baseSha.slice(0, 12)}</code>
            </div>
            <div>
              <span>合并条件</span>
              <strong>{pr.mergeStatus}</strong>
            </div>
          </div>
          {pr.body && (
            <details className="remote-pr-description">
              <summary>请求说明</summary>
              <p>{pr.body}</p>
            </details>
          )}
          <section className="conversation-git-checks">
            <div className="conversation-git-section-heading">
              <strong>远程 CI / 检查</strong>
              <span>
                {pr.checks.filter((check) => check.status === "passed").length}/
                {pr.checks.length} 通过
              </span>
            </div>
            {pr.checksError ? (
              <p className="git-actions-error">{pr.checksError}</p>
            ) : !pr.checks.length ? (
              <p className="git-actions-description">
                平台未返回检查记录。最终合并仍受远程仓库规则约束。
              </p>
            ) : (
              <VirtualList
                items={pr.checks}
                label="远程检查列表"
                rowHeight={34}
                maxHeight={238}
                getKey={(check, index) => `${check.name}:${index}`}
                renderRow={(check) => (
                  <div className="remote-pr-check" title={check.name}>
                    {check.status === "passed" ? (
                      <Check size={13} />
                    ) : check.status === "pending" ? (
                      <LoaderCircle size={13} />
                    ) : (
                      <CircleAlert size={13} />
                    )}
                    <span>{check.name}</span>
                    <small>
                      {
                        {
                          passed: "通过",
                          failed: "失败",
                          pending: "等待中",
                          unknown: "未知",
                        }[check.status]
                      }
                    </small>
                  </div>
                )}
              />
            )}
          </section>
          {pr.draft && (
            <p className="remote-pr-notice">
              这是草稿，请先在 {platform.split(" ")[0]}{" "}
              标记为可审核，再执行同步或合并。
            </p>
          )}
          {pr.mergeable === false && (
            <p className="remote-pr-notice">
              远程分支存在冲突。可以创建隔离冲突任务，审阅解决结果后再推送到来源分支。
            </p>
          )}
          {task.resolution && (
            <p className="remote-pr-notice">
              已关联本地冲突任务。先在对应任务卡确认候选，再推送解决结果。
            </p>
          )}
          {!pr.sameRepository && (
            <p className="remote-pr-notice">
              这是 Fork 请求；本地同步和冲突推送需在来源仓库处理。
            </p>
          )}
          {error && (
            <p role="alert" className="git-actions-error px-4 pb-3">
              {error}
            </p>
          )}
        </div>
        <footer className="conversation-git-footer">
          <span className="conversation-git-footer-status">
            {busy ? (
              <>
                <LoaderCircle size={13} className="git-actions-spin" />
                正在执行远程操作…
              </>
            ) : (
              <>
                {local.branch || "Detached HEAD"} ·{" "}
                {local.dirty ? "工作区有改动" : "工作区干净"}
              </>
            )}
          </span>
          <div className="conversation-git-actions">
            {ready && pr.sameRepository && (
              <>
                <Button
                  size="sm"
                  disabled={!writable}
                  onClick={() => setPending("update_branch")}
                >
                  {task.repository.provider === "github"
                    ? "同步目标到 PR"
                    : "Rebase 来源分支"}
                </Button>
                <Button
                  size="sm"
                  disabled={!writable || pr.mergeable !== false}
                  onClick={() => setPending("resolve_conflicts")}
                >
                  解决冲突
                </Button>
                {task.resolution && (
                  <Button
                    size="sm"
                    disabled={!writable}
                    onClick={() => setPending("publish_resolution")}
                  >
                    推送解决结果
                  </Button>
                )}
              </>
            )}
            <Button
              size="sm"
              disabled={
                !writable ||
                !pr.sameRepository ||
                local.dirty ||
                ![pr.head, pr.base].includes(local.branch)
              }
              onClick={() => setPending("sync_local")}
            >
              同步本地
            </Button>
            {pr.state === "open" && (
              <Button
                variant="primary"
                size="sm"
                disabled={!writable || !canMerge}
                onClick={() => setPending("merge")}
              >
                <GitMerge size={13} />
                合并远程请求
              </Button>
            )}
          </div>
        </footer>

        <div className="conversation-git-caption">
          <span>远程状态 · 单一任务持续更新</span>
          <span>{readOnly ? "历史只读" : "远程请求"}</span>
        </div>
      </section>
      {pending && (
        <Dialog
          open
          onClose={() => {
            if (!busy) setPending(null);
          }}
          dismissible={!busy}
        >
          <DialogContainer size="sm">
            <DialogPanel>
              <DialogTitle>{actionNames[pending]}</DialogTitle>
              <DialogBody>
                <p className="git-actions-description">
                  {pending === "merge"
                    ? `将在 ${platform} #${pr.number} 中合并 ${pr.head} 到 ${pr.base}。`
                    : pending === "update_branch"
                      ? task.repository.provider === "github"
                        ? `把 ${pr.base} 合入远程 ${pr.head}，会更新来源分支并重新运行检查。`
                        : `请求 GitLab 将 ${pr.head} rebase 到 ${pr.base}；可能重写来源分支提交。`
                      : pending === "sync_local"
                        ? `仅快进当前本地 ${local.branch} 到远程版本，存在分叉时停止。`
                        : pending === "resolve_conflicts"
                          ? "拉取远程来源和目标的快照，在隔离工作树中生成冲突任务。当前工作区不切换分支。"
                          : "把已确认的隔离解决提交普通推送到 PR 来源分支。远程基线发生变化时会拒绝执行。"}
                </p>
                <code className="text-xs break-all">
                  {task.repository.host}/{task.repository.path} ·{" "}
                  {pr.headSha.slice(0, 12)}
                </code>
                {pending === "merge" && (
                  <Select
                    label="合并方式"
                    value={method}
                    disabled={busy}
                    onChange={(value) => setMethod(value as typeof method)}
                    options={[
                      { value: "merge", label: "Merge commit" },
                      { value: "squash", label: "Squash" },
                      ...(task.repository.provider === "github"
                        ? [{ value: "rebase", label: "Rebase" }]
                        : []),
                    ]}
                  />
                )}
              </DialogBody>
              <DialogFooter>
                <Button disabled={busy} onClick={() => setPending(null)}>
                  返回
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void perform()}
                >
                  确认{pending === "merge" ? "远程合并" : "执行"}
                </Button>
              </DialogFooter>
            </DialogPanel>
          </DialogContainer>
        </Dialog>
      )}
    </>
  );
}
