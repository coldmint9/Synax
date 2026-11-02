import { useCallback, useEffect, useRef, useState } from "react";
import {
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
import { Select } from "../../../shared/ui/ui/Select";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useTranscriptSession } from "../SessionTranscriptContext";
import { refreshWorkspace } from "../workspaceRefresh";
import MergeRequestOverview from "./MergeRequestOverview";
import { mergeRequestRef, mergeRequestTerms } from "./mrTerms";
import "../git-merge/conversationGit.css";
import "./gitActions.css";

export default function MergeRequestCard({
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
  /** A manual refresh supersedes the read the poll may still be holding. */
  const refresh = useCallback(async () => {
    readController.current?.abort();
    await load();
  }, [load]);
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
        // The remote action already succeeded; a failed card fetch must not be
        // reported as a failed merge. The card loads the local task on its own.
        try {
          const { conversationGitApi } =
            await import("../../../adapters/transport/conversationGit");
          const local = await conversationGitApi.get(
            reference.sessionId,
            result.resolutionReference.objectId,
          );
          useAgentSessionStore
            .getState()
            .ingestConversationMessages(reference.sessionId, local.messages);
        } catch {
          /* the primary result stands */
        }
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
              onClick={() => void refresh().catch((e) => setError(e.message))}
            >
              重试
            </Button>
          </>
        ) : (
          <>正在读取合并请求…</>
        )}
      </section>
    );
  const { pr, task, local } = snapshot;
  const terms = mergeRequestTerms(task.repository.provider);
  const writable = !readOnly && sessionId === reference.sessionId && !busy;
  const ready = pr.state === "open" && !pr.draft;
  const canMerge =
    ready &&
    pr.mergeable === true &&
    !pr.checksError &&
    pr.checks.every((check) => check.status === "passed");
  const actionNames: Record<RemotePrAction["action"], string> = {
    merge: `合并 ${terms.short}`,
    update_branch: `更新 ${terms.short} 来源分支`,
    sync_local: "同步本地",
    resolve_conflicts: "在隔离工作树解决冲突",
    publish_resolution: "推送解决结果到远程",
  };
  const stateLabel =
    pr.state === "merged"
      ? "已合并"
      : pr.state === "closed"
        ? "已关闭"
        : pr.draft
          ? "草稿"
          : pr.mergeable === false
            ? "存在冲突"
            : pr.mergeStatus === "mergeable" || pr.mergeable === true
              ? "可合并"
              : "等待检查";
  return (
    <>
      <section
        className="conversation-git-card conversation-git-card--window"
        aria-label={`${terms.full} ${mergeRequestRef(terms, pr.number)}`}
        data-object-id={reference.objectId}
      >
        <header className="conversation-git-card__header">
          <div className="conversation-git-card__title">
            <span className="conversation-git-card__icon">
              {task.repository.provider === "gitlab" ? (
                <GitMerge size={18} />
              ) : (
                <GitPullRequest size={18} />
              )}
            </span>
            <div>
              <h3>{pr.title}</h3>
              <p>
                {task.repository.host}/{task.repository.path}
              </p>
            </div>
          </div>
          <div className="conversation-git-card__header-actions">
            <span
              role="status"
              className={`mr-state mr-state--${pr.state === "open" ? (pr.mergeable === false ? "blocked" : "open") : pr.state}`}
            >
              {pr.state === "merged" && <Check size={12} aria-hidden />}
              {pr.state === "open" && pr.mergeable === false && (
                <CircleAlert size={12} aria-hidden />
              )}
              {stateLabel}
            </span>
            <Button
              iconOnly
              size="sm"
              variant="ghost"
              aria-label={`刷新 ${terms.short}`}
              disabled={busy}
              onClick={() => {
                setError("");
                void refresh().catch((e) => {
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
          aria-label={`${terms.full} 内容`}
          tabIndex={0}
        >
          <MergeRequestOverview pr={pr} terms={terms} />
          {pr.draft && (
            <p className="remote-pr-notice">
              草稿：在 {terms.platform} 标记为可审核后即可合并。
            </p>
          )}
          {pr.mergeable === false && (
            <p className="remote-pr-notice">
              远程分支存在冲突。可先创建隔离冲突任务，确认解决结果后再推送。
            </p>
          )}
          {task.resolution && (
            <p className="remote-pr-notice">
              已关联本地冲突任务：确认候选结果后推送。
            </p>
          )}
          {!pr.sameRepository && (
            <p className="remote-pr-notice">
              Fork 请求：本地同步和冲突推送需在来源仓库处理。
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
                title={
                  canMerge ? undefined : `等待 ${terms.platform} 的合并条件`
                }
                onClick={() => setPending("merge")}
              >
                <GitMerge size={13} />
                合并 {terms.short}
              </Button>
            )}
          </div>
        </footer>

        <div className="conversation-git-caption">
          <span>
            {terms.platform} · {task.repository.path}
          </span>
          <span>{readOnly ? "历史只读" : "实时状态"}</span>
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
                    ? `将在 ${terms.full} ${terms.symbol}${pr.number} 中合并 ${pr.head} 到 ${pr.base}。`
                    : pending === "update_branch"
                      ? task.repository.provider === "github"
                        ? `把 ${pr.base} 合入远程 ${pr.head}，会更新来源分支并重新运行检查。`
                        : `请求 GitLab 将 ${pr.head} rebase 到 ${pr.base}；可能重写来源分支提交。`
                      : pending === "sync_local"
                        ? `仅快进当前本地 ${local.branch} 到远程版本，存在分叉时停止。`
                        : pending === "resolve_conflicts"
                          ? "拉取远程来源和目标的快照，在隔离工作树中生成冲突任务。当前工作区不切换分支。"
                          : "把已确认的隔离解决提交推送到来源分支。远程基线变化时会拒绝执行。"}
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
                  {pending === "merge" ? "确认合并" : "确认执行"}
                </Button>
              </DialogFooter>
            </DialogPanel>
          </DialogContainer>
        </Dialog>
      )}
    </>
  );
}
