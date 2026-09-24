import { useConversationHistoryVisit } from "./useConversationHistoryVisit";
import { subscribe } from "../../../lib/api/runtimeEventBus";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, Modal, Spinner } from "@heroui/react";
import { GitFork, RotateCcw, AlertTriangle } from "lucide-react";
import {
  conversationHistoryApi,
  type HistoryAction,
  type ForkWorkspaceMode,
  type HistoryPreview,
  type HistorySummary,
  type MessageCheckpoint,
} from "../../../lib/api/conversationHistory";
import type {
  AgentRuntimeMessage,
  AgentSession,
} from "../../../lib/api/agentRuntime";
import { isRuntimeResourceGone } from "../../../lib/runtimeResourceRegistry";
import { useLocale } from "../../../hooks/useLocale";
import { useAgentSessionStore } from "./state/agentSessionStore";

interface ContextValue {
  reason: string | null;
  forkReason: string | null;
  running: boolean;
  busy: boolean;
  error: string | null;
  checkpoint: (
    messageId?: string,
    stepId?: string,
  ) => MessageCheckpoint | undefined;
  request: (
    action: HistoryAction,
    checkpoint: MessageCheckpoint,
    message?: string,
  ) => Promise<boolean>;
}
const HistoryContext = createContext<ContextValue | null>(null);
const ACTIVE_STATUSES = new Set<AgentSession["status"]>([
  "running",
  "queued",
  "waiting_permission",
  "waiting_input",
]);
export const useSessionHistory = () => useContext(HistoryContext);
interface Pending {
  action: HistoryAction;
  checkpoint: MessageCheckpoint;
  message?: string;
  requestId: string;
  sessionId: string;
}
export function SessionHistoryProvider({
  session,
  messages,
  children,
}: {
  session?: AgentSession;
  messages: AgentRuntimeMessage[];
  children: ReactNode;
}) {
  const { locale } = useLocale(),
    zh = locale === "zh";
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [preview, setPreview] = useState<HistoryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const requestEpoch = useRef(0);
  const sessionId = session?.id;
  useConversationHistoryVisit(sessionId);
  const [includeFiles, setIncludeFiles] = useState(true);
  const [forkMode, setForkMode] = useState<ForkWorkspaceMode>();
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      // A removed or archived session owns no checkpoints; skip the doomed
      // fetch instead of surfacing a NOT_FOUND the user never caused.
      if (!sessionId || isRuntimeResourceGone(sessionId)) return;
      try {
        const result = await conversationHistoryApi.list(sessionId, signal);
        if (!signal?.aborted) {
          setSummary(result);
          setLoadError(null);
        }
      } catch (e) {
        if (!signal?.aborted) setLoadError((e as Error).message);
      }
    },
    [sessionId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [
    refresh,
    session?.status,
    session?.updatedAt,
    messages.length,
    messages[messages.length - 1]?.id,
  ]);
  useEffect(
    () =>
      subscribe({
        events: {
          session_checkpoint_changed: (e) => {
            if (JSON.parse(e.data).sessionId === sessionId) void refresh();
          },
        },
      }),
    [sessionId, refresh],
  );
  useEffect(() => {
    setPending(null);
    setPreview(null);
    setError(null);
    setExecuting(false);
    return () => {
      requestEpoch.current++;
      resolver.current?.(false);
      resolver.current = null;
    };
  }, [sessionId]);
  const close = useCallback((ok = false) => {
    requestEpoch.current++;
    setPending(null);
    setPreview(null);
    setError(null);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);
  const request = useCallback(
    async (
      action: HistoryAction,
      checkpoint: MessageCheckpoint,
      message?: string,
    ): Promise<boolean> => {
      if (!sessionId || executing || resolver.current) return false;
      if (
        action !== "fork" &&
        session?.sessionMetadata?.historyRollbackEnabled === false
      ) {
        setError(
          zh
            ? "分叉会话只追加历史，不支持回滚或编辑重发"
            : "Forked conversations are append-only; rollback and history editing are disabled.",
        );
        return false;
      }
      const epoch = ++requestEpoch.current;
      const requestId = crypto.randomUUID();
      setIncludeFiles(action !== "fork");
      setForkMode(undefined);
      setPending({
        action,
        checkpoint,
        message,
        requestId,
        sessionId,
      });
      setPreview(null);
      setError(null);

      const stopIfRunning = async () => {
        const store = useAgentSessionStore.getState();
        const current = store.sessions.find((entry) => entry.id === sessionId);
        if (!ACTIVE_STATUSES.has(current?.status ?? session?.status ?? "completed"))
          return;
        await store.cancelSessionRun(sessionId);
        if (epoch !== requestEpoch.current) return;
        const updated = await conversationHistoryApi.list(sessionId);
        if (epoch !== requestEpoch.current) return;
        setSummary(updated);
        const selected = updated.checkpoints.find((item) => item.id === checkpoint.id);
        if (selected && !selected.available)
          throw new Error(
            zh
              ? "检查点已变化，请重新选择消息"
              : "Checkpoint changed; select the message again.",
          );
      };

      // Editing an already sent user message is intentionally a one-step,
      // conversation-only operation. The inline editor owns the warning and
      // retry state; file restoration remains opt-in through the full rollback
      // dialog, so an edit cannot silently overwrite workspace files.
      if (action === "edit") {
        setExecuting(true);
        try {
          await stopIfRunning();
          if (epoch !== requestEpoch.current) return false;
          const value = await conversationHistoryApi.preview(
            sessionId,
            checkpoint.id,
            action,
            false,
          );
          if (epoch !== requestEpoch.current) return false;
          setPreview(value);
          if (!value.canApply) {
            const conflict = value.conflicts[0];
            throw new Error(
              conflict
                ? `${conflict.path}: ${conflict.reason}`
                : zh
                  ? "当前会话状态已变化，请重试"
                  : "The conversation changed; please retry.",
            );
          }
          await conversationHistoryApi.apply(sessionId, action, {
            checkpointId: checkpoint.id,
            revision: value.revision,
            requestId,
            message,
            includeFiles: false,
          });
          const store = useAgentSessionStore.getState();
          store.resetConversationHistory(sessionId);
          await Promise.all([store.refreshSessions(), store.refreshDetail()]);
          close(true);
          void refresh();
          return true;
        } catch (e) {
          if (epoch === requestEpoch.current) setError((e as Error).message);
          return false;
        } finally {
          setExecuting(false);
        }
      }

      const result = new Promise<boolean>((resolve) => {
        resolver.current = resolve;
      });
      if (action === "fork") return result;
      void (async () => {
        try {
          setExecuting(true);
          await stopIfRunning();
          if (epoch !== requestEpoch.current) return;
          const value = await conversationHistoryApi.preview(
            sessionId,
            checkpoint.id,
            action,
          );
          if (epoch === requestEpoch.current) setPreview(value);
        } catch (e) {
          if (epoch === requestEpoch.current) setError((e as Error).message);
        } finally {
          setExecuting(false);
        }
      })();
      return result;
    },
    [sessionId, session, executing, zh, close, refresh],
  );
  const changeFilePolicy = (value: boolean) => {
    if (!pending || executing) return;
    setIncludeFiles(value);
    setPreview(null);
    setError(null);
    const epoch = ++requestEpoch.current;
    void conversationHistoryApi
      .preview(pending.sessionId, pending.checkpoint.id, pending.action, value)
      .then((result) => {
        if (epoch === requestEpoch.current) setPreview(result);
      })
      .catch((error) => {
        if (epoch === requestEpoch.current) setError((error as Error).message);
      });
  };
  const chooseForkMode = (mode: ForkWorkspaceMode) => {
    if (!pending || pending.action !== "fork" || executing) return;
    setForkMode(mode);
    setPreview(null);
    setError(null);
    setPending({ ...pending, requestId: crypto.randomUUID() });
    const epoch = ++requestEpoch.current;
    void conversationHistoryApi
      .preview(pending.sessionId, pending.checkpoint.id, "fork", false, mode)
      .then((value) => {
        if (epoch === requestEpoch.current) setPreview(value);
      })
      .catch((error) => {
        if (epoch === requestEpoch.current) setError((error as Error).message);
      });
  };
  const confirm = async () => {
    if (
      !pending ||
      !preview ||
      executing ||
      !preview.canApply ||
      (pending.action === "fork" && !forkMode)
    )
      return;
    setExecuting(true);
    setError(null);
    try {
      const result = await conversationHistoryApi.apply(
        pending.sessionId,
        pending.action,
        {
          checkpointId: pending.checkpoint.id,
          revision: preview.revision,
          requestId: pending.requestId,
          message: pending.message,
          includeFiles: pending.action === "fork" ? false : includeFiles,
          ...(pending.action === "fork" ? { workspaceMode: forkMode } : {}),
        },
      );
      const store = useAgentSessionStore.getState();
      if (pending.action === "fork") {
        await store.refreshSessions();
        store.openPanel(result.sessionId);
      } else {
        store.resetConversationHistory(pending.sessionId);
        await Promise.all([store.refreshSessions(), store.refreshDetail()]);
      }
      close(true);
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExecuting(false);
    }
  };
  const value = useMemo<ContextValue>(
    () => ({
      reason:
        summary && summary.sessionId === sessionId
          ? summary.stopRequired && session && ACTIVE_STATUSES.has(session.status)
            ? null
            : summary.reason
          : loadError ||
            (zh ? "正在检查会话边界" : "Checking conversation checkpoints"),
      forkReason:
        summary && summary.sessionId === sessionId
          ? summary.forkReason !== undefined
            ? summary.forkReason
            : summary.reason
          : loadError ||
            (zh ? "正在检查会话边界" : "Checking conversation checkpoints"),
      running: Boolean(session && ACTIVE_STATUSES.has(session.status)),
      busy: Boolean(pending),
      error,
      request,
      checkpoint: (messageId, stepId) => {
        if (!summary || summary.sessionId !== sessionId) return undefined;
        if (messageId?.startsWith("user-input-"))
          return summary.checkpoints.find((c) => c.initialInput);
        const found = summary.checkpoints.find((c) =>
          messageId
            ? c.messageId === messageId
            : stepId && c.kind === "reply" && c.stepId === stepId,
        );
        if (!found && summary.rollbackEnabled === false) {
          const reply = messages.find((message) =>
            messageId ? message.id === messageId : message.stepId === stepId,
          );
          if (reply?.role === "assistant" && !reply.metadata?.partial)
            return {
              id: `message:${reply.id}`,
              kind: "reply",
              messageId: reply.id,
              stepId: reply.stepId,
              available: true,
              reason: null,
              canRollback: false,
              hasLaterHistory: false,
              initialInput: false,
            };
        }
        const projected = messages.find(
          (message) => message.id === found?.messageId,
        )?.historyProjection;
        return found?.kind === "input" && projected
          ? {
              ...found,
              available: false,
              reason: zh
                ? "这是长消息预览，请勿用截断内容覆盖原消息"
                : "This is a long-message preview; editing it would overwrite omitted content",
            }
          : found;
      },
    }),
    [
      session,
      sessionId,
      summary,
      loadError,
      pending,
      error,
      request,
      zh,
      messages,
    ],
  );
  const fork = pending?.action === "fork",
    edit = pending?.action === "edit";
  const title = fork
    ? zh
      ? "从此处创建分支会话"
      : "Fork conversation here"
    : edit
      ? zh
        ? "编辑并重新发送"
        : "Edit and resend"
      : zh
        ? "回滚到此处"
        : "Roll back to here";
  return (
    <HistoryContext.Provider value={value}>
      {summary?.recoveryRequired && (
        <div
          role="alert"
          className="mx-auto my-2 flex max-w-3xl items-center gap-3 rounded-xl border border-warning/25 bg-warning/5 p-3 text-sm"
        >
          <span>
            {zh
              ? "上一次历史操作需要恢复，完成前已暂停本工作区的写入。"
              : "A previous history operation needs recovery. Workspace writes are fenced until it is resolved."}
          </span>
          <Button
            size="sm"
            variant="secondary"
            isPending={executing}
            onPress={() => {
              if (!sessionId) return;
              setExecuting(true);
              void conversationHistoryApi
                .recover(sessionId)
                .then(() => {
                  setLoadError(null);
                  void refresh();
                })
                .catch((e) => setLoadError((e as Error).message))
                .finally(() => setExecuting(false));
            }}
          >
            {zh ? "恢复" : "Recover"}
          </Button>
          {loadError && <span className="text-danger">{loadError}</span>}
        </div>
      )}
      {session?.sessionMetadata?.historyRollbackEnabled === false && (
        <p
          className="mx-auto max-w-3xl px-4 text-xs text-muted-foreground"
          role="note"
        >
          {zh
            ? "分叉会话：只追加历史，不支持回滚或编辑旧消息；可继续对话或再次分叉。"
            : "Forked conversation: append-only; no rollback or editing earlier messages. Continue chatting or fork again."}
        </p>
      )}
      {children}
      <Modal.Backdrop
        isOpen={Boolean(pending && pending.action !== "edit")}
        onOpenChange={(open) => {
          if (!open && !executing) close();
        }}
        isDismissable={!executing}
      >
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon>
                {fork ? <GitFork size={19} /> : <RotateCcw size={19} />}
              </Modal.Icon>
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3 text-sm">
              <p>
                {fork
                  ? zh
                    ? "复制到选中回复为止的会话历史，不会停止源会话。请选择工作树方式；新会话不支持回滚或编辑旧消息。"
                    : "Copy the conversation through this reply without stopping the source. Choose a worktree mode; the new conversation is append-only."
                  : zh
                    ? "后续消息将被裁剪。文件撤销仅针对本会话明确记录、尚未提交且未过期的变更；其他文件不会改动。"
                    : "Later conversation records will be trimmed. File undo only affects this session’s recorded, uncommitted, unexpired changes; unrelated files are preserved."}
              </p>
              {fork ? (
                <fieldset className="flex flex-col gap-3" disabled={executing}>
                  <legend className="mb-2 font-medium">
                    {zh ? "工作树方式（必选）" : "Worktree mode (required)"}
                  </legend>
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="fork-workspace-mode"
                      value="new_worktree"
                      checked={forkMode === "new_worktree"}
                      onChange={() => chooseForkMode("new_worktree")}
                    />
                    <span>
                      <strong>
                        {zh ? "新建工作树" : "Create a new worktree"}
                      </strong>
                      <br />
                      <span className="text-xs text-muted-foreground">
                        {zh
                          ? "从当前 Git 提交建立独立工作目录；不复制未提交修改、忽略文件或依赖环境。"
                          : "Independent directory at the current Git commit; uncommitted changes, ignored files and dependencies are not copied."}
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="fork-workspace-mode"
                      value="reuse_worktree"
                      checked={forkMode === "reuse_worktree"}
                      onChange={() => chooseForkMode("reuse_worktree")}
                    />
                    <span>
                      <strong>
                        {zh ? "维持原工作树" : "Keep the existing worktree"}
                      </strong>
                      <br />
                      <span className="text-xs text-warning">
                        {zh
                          ? "仅复制会话，不复制目录。两份会话会修改同一份文件。"
                          : "Copy the conversation only. Both conversations can change the same files."}
                      </span>
                    </span>
                  </label>
                </fieldset>
              ) : (
                <>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={includeFiles}
                      disabled={executing}
                      onChange={(event) =>
                        changeFilePolicy(event.target.checked)
                      }
                      className="mt-1 accent-[var(--accent)]"
                    />
                    <span>
                      {zh
                        ? "同时撤销本会话记录的未提交文件变更"
                        : "Also undo this session’s recorded uncommitted file changes"}
                    </span>
                  </label>
                  {!includeFiles && (
                    <p className="text-xs text-muted-foreground">
                      {zh
                        ? "仅裁剪会话历史，已有工作目录中的文件保持不变。"
                        : "Trim conversation only; files in the existing workspace remain unchanged."}
                    </p>
                  )}
                </>
              )}
              {!preview && !error && (!fork || forkMode) && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Spinner size="sm" />
                  {zh ? "正在检查消息和文件…" : "Checking messages and files…"}
                </div>
              )}
              {preview && (
                <>
                  <p className="text-muted-foreground">
                    {fork
                      ? zh
                        ? `${forkMode === "new_worktree" ? "新建工作树" : "维持原工作树"} · 新会话不支持回滚`
                        : `${forkMode === "new_worktree" ? "New worktree" : "Existing worktree"} · append-only conversation`
                      : zh
                        ? `截断 ${preview.removedMessages} 条消息 · 恢复 ${preview.files.length} 个文件`
                        : `Remove ${preview.removedMessages} messages · restore ${preview.files.length} files`}
                  </p>
                  {preview.files.length > 0 && (
                    <ul className="message-history-files">
                      {preview.files.slice(0, 80).map((file) => (
                        <li key={`${file.root}/${file.path}`} title={file.root}>
                          <span className="mr-2 text-muted-foreground">
                            {file.action === "delete" ? "−" : "↶"}
                          </span>
                          {file.path}
                        </li>
                      ))}
                      {preview.files.length > 80 && (
                        <li>… +{preview.files.length - 80}</li>
                      )}
                    </ul>
                  )}
                  {Boolean(preview.preservedFiles?.length) && (
                    <div
                      className="rounded-xl border border-warning/20 bg-warning/5 p-3"
                      role="status"
                    >
                      <p className="mb-2 font-medium">
                        {zh
                          ? "以下文件变更将保留，不影响会话裁剪"
                          : "These file changes will be preserved; conversation trimming is still available"}
                      </p>
                      <ul className="max-h-36 overflow-auto text-xs">
                        {preview.preservedFiles!.map((file, index) => (
                          <li
                            key={index}
                            className="break-words py-1"
                            title={file.root}
                          >
                            {file.path} ·{" "}
                            {zh
                              ? {
                                  committed: "已被 Git 提交",
                                  git_unverified: "Git 状态无法确认，保留文件",
                                  expired: "超过 24 小时未访问，撤销记录已清理",
                                  untracked: "无法可靠归属，不自动撤销",
                                  workspace: "工作目录已变更",
                                }[file.kind]
                              : file.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {Boolean(preview.warnings?.length) && (
                    <p
                      className="text-xs leading-relaxed text-warning"
                      role="status"
                    >
                      {zh
                        ? "部分旧历史、Shell/MCP 或外部变更没有可用的文件撤销记录，将保留这些文件；只处理上方明确列出的可撤销变更。"
                        : preview.warnings!.join(" ")}
                    </p>
                  )}
                  {preview.conflicts.length > 0 && (
                    <div
                      role="alert"
                      className="rounded-xl bg-danger/5 p-3 text-danger"
                    >
                      <div className="mb-2 flex items-center gap-2">
                        <AlertTriangle size={16} />
                        {zh
                          ? "存在冲突，尚未更改任何内容"
                          : "Conflicts found. Nothing has changed."}
                      </div>
                      <ul>
                        {preview.conflicts.map((c, i) => (
                          <li key={i} className="break-words text-xs">
                            {c.path}: {c.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {!fork &&
                      (zh
                        ? "24 小时未主动访问会话后，文件撤销记录自动清理，聊天历史保留。Git 已提交的变更、外部数据库与网络操作不会被撤销。"
                        : "File undo expires after 24 hours without an active visit; conversation history remains. Git commits, external databases and network effects are preserved.")}
                    {fork &&
                      forkMode === "new_worktree" &&
                      (zh
                        ? " 新工作目录可能需要重新准备环境。"
                        : " The new workspace may need environment setup.")}
                  </p>
                </>
              )}
              {error && (
                <p role="alert" className="break-words text-danger">
                  {error}
                </p>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button
                size="sm"
                variant="ghost"
                onPress={() => close()}
                isDisabled={executing}
              >
                {zh ? "取消" : "Cancel"}
              </Button>
              <Button
                size="sm"
                variant={fork ? "primary" : "danger"}
                isPending={executing}
                isDisabled={
                  !preview?.canApply || executing || (fork && !forkMode)
                }
                onPress={() => void confirm()}
              >
                {title}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </HistoryContext.Provider>
  );
}
