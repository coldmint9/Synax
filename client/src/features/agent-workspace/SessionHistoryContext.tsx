import { useConversationHistoryVisit } from "./useConversationHistoryVisit";
import { subscribe } from "../../adapters/transport/runtimeEventBus";
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
import { Dialog, DialogContainer, DialogPanel, DialogHeader, DialogIcon, DialogTitle, DialogBody, DialogFooter } from "@/shared/ui/ui/Dialog";
import { Spinner } from "@/shared/ui/ui/Display";
import { Button } from "@/shared/ui/ui/Button";
import { RotateCcw, AlertTriangle } from "lucide-react";
import {
  conversationHistoryApi,
  type HistoryAction,
  type ForkWorkspaceMode,
  type HistoryPreview,
  type HistorySummary,
  type MessageCheckpoint,
} from "../../adapters/transport/conversationHistory";
import type {
  AgentRuntimeMessage,
  AgentSession,
} from "../../adapters/transport/agentRuntime";
import { isRuntimeResourceGone } from "../../shared/lib/runtimeResourceRegistry";
import { useLocale } from "../../shared/hooks/useLocale";
import { useNotificationStore } from "../../shared/state/notificationStore";
import { useAgentSessionStore } from "./state/agentSessionStore";

interface ContextValue {
  reason: string | null;
  forkReason: string | null;
  running: boolean;
  busy: boolean;
  error: string | null;
  editReason: (messageId?: string) => string | null;
  edit: (messageId: string, message: string) => Promise<boolean>;
  checkpoint: (
    messageId?: string,
    stepId?: string,
  ) => MessageCheckpoint | undefined;
  request: (
    action: HistoryAction,
    checkpoint: MessageCheckpoint,
    message?: string,
    workspaceMode?: ForkWorkspaceMode,
  ) => Promise<boolean>;
}
const HistoryContext = createContext<ContextValue | null>(null);
const ACTIVE_STATUSES = new Set<AgentSession["status"]>([
  "running",
  "queued",
  "waiting_permission",
  "waiting_input",
]);
// 检查点只在稳定边界预取，避免流式响应期间重复读取。运行中的分叉由
// TurnBody 提供消息/步骤定位，用户选择工作区后再按需读取一次摘要。
const SETTLED_STATUSES = new Set<AgentSession["status"]>([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "paused",
  "waiting_permission",
  "waiting_input",
]);
export const useSessionHistory = () => useContext(HistoryContext);
const PRESERVED_KIND_ZH: Record<
  NonNullable<HistoryPreview["preservedFiles"]>[number]["kind"],
  string
> = {
  committed: "已被 Git 提交",
  git_unverified: "Git 状态无法确认，保留文件",
  expired: "超过 24 小时未访问，撤销记录已清理",
  untracked: "无法可靠归属，不自动撤销",
  workspace: "工作目录已变更",
};
interface Pending {
  action: HistoryAction;
  checkpoint: MessageCheckpoint;
  message?: string;
  requestId: string;
  sessionId: string;
}
function findCheckpoint(
  summary: HistorySummary,
  messages: AgentRuntimeMessage[],
  messageId: string | undefined,
  stepId: string | undefined,
  zh: boolean,
): MessageCheckpoint | undefined {
  if (messageId?.startsWith("user-input-"))
    return summary.checkpoints.find((c) => c.initialInput);
  const found = summary.checkpoints.find((c) =>
    messageId
      ? c.messageId === messageId
      : stepId && c.kind === "reply" && c.stepId === stepId,
  );
  // An empty checkpoint list says nothing about whether this is a fork.
  // Only stored checkpoints can be previewed/applied by the history API.
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
  const messageIndex = useMemo(() => new Map(messages.map(message => [message.id, message])), [messages]);
  const checkpointIndex = useMemo(() => {
    const byMessage = new Map<string, MessageCheckpoint>();
    const byStep = new Map<string, MessageCheckpoint>();
    let initial: MessageCheckpoint | undefined;
    const readOnly = new Set(summary?.sessionId === sessionId ? summary?.readOnlyMessageIds ?? [] : []);
    if (summary && summary.sessionId === sessionId) for (const checkpoint of summary.checkpoints) {
      byMessage.set(checkpoint.messageId, checkpoint);
      if (checkpoint.kind === "reply" && checkpoint.stepId) byStep.set(checkpoint.stepId, checkpoint);
      if (checkpoint.initialInput) initial = checkpoint;
    }
    return { byMessage, byStep, initial, readOnly };
  }, [summary, sessionId]);
  const latestCompaction = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const state = messages[index].metadata?.contextCompaction as { status?: string; checkpointId?: string } | undefined;
      if (state?.status === "completed" && state.checkpointId) return state.checkpointId;
    }
    return null;
  }, [messages]);
  // 消息列表只用来过滤结果，不再作为请求触发器；否则每次流式增量都会带上
  // 一份新的 id 列表再请求一遍 checkpoints。
  const messageIds = useRef<string[]>([]);
  messageIds.current = messages.map((message) => message.id);
  useConversationHistoryVisit(sessionId);
  const [includeFiles, setIncludeFiles] = useState(true);
  const forkInFlight = useRef(false);
  const editInFlight = useRef(false);
  const editAttempt = useRef<{ sessionId: string; messageId: string; message: string; requestId: string; submitted: boolean } | null>(null);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      // A removed or archived session owns no checkpoints; skip the doomed
      // fetch instead of surfacing a NOT_FOUND the user never caused.
      if (!sessionId || isRuntimeResourceGone(sessionId)) return;
      try {
        const result = await conversationHistoryApi.list(sessionId, signal, messageIds.current);
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
  // 与 refresh 不同，这里把结果返回给调用方：用户点击历史操作时可以直接使用
  // 刚取到的摘要，而不必等待下一轮渲染。
  const loadSummary = useCallback(async (): Promise<HistorySummary | null> => {
    const id = sessionId;
    if (!id) return null;
    return (await conversationHistoryApi.list(id, undefined, messageIds.current)) ?? null;
  }, [sessionId]);
  useEffect(() => {
    if (!latestCompaction) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [latestCompaction, refresh]);
  // 会话边界只在中断、停止、等待和完成时变化。一次运行期间不再跟随每次
  // 状态/消息变化重新拉取；在此之前由用户的回滚或分叉操作按需加载。
  const settledStatus = session?.status;
  useEffect(() => {
    const controller = new AbortController();
    if (!settledStatus || !SETTLED_STATUSES.has(settledStatus)) return;
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh, settledStatus]);
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
  const historyRequest = useCallback(
    async (
      action: HistoryAction,
      checkpoint: MessageCheckpoint,
      message?: string,
      workspaceMode?: ForkWorkspaceMode,
    ): Promise<boolean> => {
      if (!sessionId || executing || resolver.current || forkInFlight.current || editInFlight.current) return false;
      if (action === "fork" && !workspaceMode) return false;
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
      setIncludeFiles(action !== "fork" && !checkpoint.transcriptOnly && !checkpoint.destructive);
      if (action === "fork") {
        forkInFlight.current = true;
        setExecuting(true);
        setError(null);
        try {
          // Mode selection is the confirmation. Keep server validation, but no
          // intermediate dialog and never cancel the source conversation.
          const checked = await conversationHistoryApi.preview(
            sessionId, checkpoint.id, "fork", false, workspaceMode,
          );
          if (epoch !== requestEpoch.current) return false;
          if (!checked.canApply) {
            throw new Error(checked.conflicts[0]?.reason || (zh ? "当前无法分叉，请重试" : "Unable to fork. Please retry."));
          }
          const result = await conversationHistoryApi.apply(sessionId, "fork", {
            checkpointId: checkpoint.id, revision: checked.revision, requestId,
            includeFiles: false, workspaceMode,
          });
          if (epoch !== requestEpoch.current) return false;
          const store = useAgentSessionStore.getState();
          await store.refreshSessions();
          if (epoch !== requestEpoch.current) return false;
          store.openPanel(result.sessionId);
          void refresh();
          return true;
        } catch (e) {
          if (epoch === requestEpoch.current) {
            const message = (e as Error).message;
            setError(message);
            // Only actual failures are reported outside the two-option pop.
            useNotificationStore.getState().push({ type: "error", message });
          }
          return false;
        } finally {
          forkInFlight.current = false;
          if (epoch === requestEpoch.current) setExecuting(false);
        }
      }
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

      const result = new Promise<boolean>((resolve) => {
        resolver.current = resolve;
      });
      void (async () => {
        try {
          setExecuting(true);
          await stopIfRunning();
          if (epoch !== requestEpoch.current) return;
          const value = await conversationHistoryApi.preview(
            sessionId,
            checkpoint.id,
            action,
            !checkpoint.transcriptOnly && !checkpoint.destructive,
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
  const editReason = useCallback((messageId?: string): string | null => {
    if (!sessionId || !messageId || isRuntimeResourceGone(sessionId))
      return zh ? "此消息尚未保存，暂时无法编辑" : "This message is not saved yet";
    if (session?.sessionMetadata?.historyRollbackEnabled === false)
      return zh ? "分叉会话只追加历史，不支持编辑重发" : "This conversation is append-only";
    if (summary?.sessionId === sessionId && summary.recoveryRequired)
      return zh ? "请先恢复上一次历史操作" : "Recover the previous history operation first";
    const checkpoint = messageId.startsWith("user-input-") ? checkpointIndex.initial : checkpointIndex.byMessage.get(messageId);
    if (checkpointIndex.readOnly.has(messageId) || checkpoint?.reason?.startsWith("READ_ONLY_HISTORY"))
      return zh ? "这段历史已压缩，仅供查看，不能编辑或回滚" : "This history is compacted and read-only";
    if (messageIndex.get(messageId)?.historyProjection)
      return zh ? "这是长消息预览，请勿用截断内容覆盖原消息" : "Load the full message before editing";
    return null;
  }, [sessionId, session?.sessionMetadata?.historyRollbackEnabled, summary, checkpointIndex, messageIndex, zh]);
  const edit = useCallback(async (messageId: string, message: string): Promise<boolean> => {
    if (!sessionId || !message.trim() || executing || resolver.current || forkInFlight.current || editInFlight.current)
      return false;
    const reason = editReason(messageId);
    if (reason) { setError(reason); return false; }
    const epoch = ++requestEpoch.current;
    editInFlight.current = true;
    setExecuting(true);
    setError(null);
    // Preserve the request identity on retry, including a lost response after
    // the server already truncated history and accepted the replacement turn.
    const previous = editAttempt.current;
    const attempt = previous?.sessionId === sessionId && previous.messageId === messageId && previous.message === message
      ? previous : { sessionId, messageId, message, requestId: crypto.randomUUID(), submitted: false };
    editAttempt.current = attempt;
    try {
      const store = useAgentSessionStore.getState();
      const current = store.sessions.find(entry => entry.id === sessionId);
      if (!attempt.submitted && ACTIVE_STATUSES.has(current?.status ?? session?.status ?? "completed"))
        await store.cancelSessionRun(sessionId);
      if (epoch !== requestEpoch.current) return false;
      attempt.submitted = true;
      await conversationHistoryApi.edit(sessionId, {
        messageId, message, requestId: attempt.requestId,
      });
      store.resetConversationHistory(sessionId);
      void store.refreshSessions();
      if (epoch !== requestEpoch.current) return false;
      editAttempt.current = null;
      void refresh();
      return true;
    } catch (e) {
      if (epoch === requestEpoch.current) setError((e as Error).message);
      return false;
    } finally {
      editInFlight.current = false;
      if (epoch === requestEpoch.current) setExecuting(false);
    }
  }, [sessionId, session?.status, executing, editReason, refresh]);
  // 边界摘要可能还没加载（运行中不预取）：用当前消息和步骤重新定位 checkpoint，
  // 只在用户真正点击回滚或分叉时发起这一次请求；编辑按消息 ID 直接执行。
  const request = useCallback(
    async (
      action: HistoryAction,
      checkpoint: MessageCheckpoint,
      message?: string,
      workspaceMode?: ForkWorkspaceMode,
    ): Promise<boolean> => {
      const current = summary?.sessionId === sessionId ? summary : await loadSummary?.();
      if (!current) return false;
      const resolved = findCheckpoint(
        current,
        messages,
        checkpoint.messageId,
        checkpoint.stepId ?? undefined,
        zh,
      );
      if (!resolved)
        throw new Error(
          zh
            ? "此消息没有可用的会话检查点"
            : "No conversation checkpoint for this message",
        );
      return historyRequest(action, { ...checkpoint, ...resolved, transcriptOnly: checkpoint.transcriptOnly ?? resolved.transcriptOnly, destructive: checkpoint.destructive ?? resolved.destructive }, message, workspaceMode);
    },
    [historyRequest, loadSummary, messages, summary, sessionId, zh],
  );
  const changeFilePolicy = (value: boolean) => {
    if (!pending || executing || pending.checkpoint.transcriptOnly) return;
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
  const confirm = async () => {
    if (
      !pending ||
      !preview ||
      executing ||
      !preview.canApply
    )
      return;
    setExecuting(true);
    setError(null);
    try {
      await conversationHistoryApi.apply(
        pending.sessionId,
        pending.action,
        {
          checkpointId: pending.checkpoint.id,
          revision: preview.revision,
          requestId: pending.requestId,
          message: pending.message,
          includeFiles,
        },
      );
      const store = useAgentSessionStore.getState();
      store.resetConversationHistory(pending.sessionId);
      void store.refreshSessions();
      close(true);
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExecuting(false);
    }
  };
  const value = useMemo<ContextValue>(
    () => {
      // 摘要按需加载期间不预取，因此"未加载"不等于"不可用"：只在真正失败时
      // 报告原因，否则按钮会在运行期间永久置灰。
      const notLoaded =
        loadError || (zh ? "回复结束后可操作" : "Available once the run settles");
      return {
      reason:
        summary && summary.sessionId === sessionId
          ? summary.stopRequired && session && ACTIVE_STATUSES.has(session.status)
            ? null
            : summary.reason
          : session && ACTIVE_STATUSES.has(session.status)
            ? null
            : notLoaded,
      // A running source can be forked from any checkpoint already persisted.
      // Keep the action usable while the lightweight checkpoint query is in
      // flight; request() resolves the exact checkpoint before applying.
      forkReason:
        summary && summary.sessionId === sessionId
          ? summary.forkReason !== undefined
            ? summary.forkReason
            : summary.reason
          : session && ACTIVE_STATUSES.has(session.status)
            ? null
            : notLoaded,
      running: Boolean(session && ACTIVE_STATUSES.has(session.status)),
      busy: Boolean(pending) || executing,
      error,
      edit,
      editReason,
      request,
      checkpoint: (messageId, stepId) => {
        if (!summary || summary.sessionId !== sessionId) return undefined;
        const found = messageId?.startsWith("user-input-") ? checkpointIndex.initial
          : messageId ? checkpointIndex.byMessage.get(messageId) : stepId ? checkpointIndex.byStep.get(stepId) : undefined;
        if (found?.kind === "input" && messageIndex.get(found.messageId)?.historyProjection)
          return { ...found, available: false, reason: zh ? "这是长消息预览，请勿用截断内容覆盖原消息" : "Load the full message before editing" };
        return found;
      },
      };
    },
    [
      session,
      checkpointIndex,
      messageIndex,
      sessionId,
      summary,
      loadError,
      pending,
      error,
      edit,
      editReason,
      request,
      executing,
      zh,
      messages,
    ],
  );
  const title = pending?.checkpoint.destructive
    ? (zh ? "永久截取到此处" : "Permanently trim to here")
    : (zh ? "回滚到此处" : "Roll back to here");
  const outOfScope = (preview?.preservedFiles ?? []).map(
    (file) => `${file.path} · ${zh ? PRESERVED_KIND_ZH[file.kind] : file.reason}`,
  );
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
            pending={executing}
            onClick={() => {
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
          {loadError && <span role="alert" className="text-danger">{loadError}</span>}
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
      <Dialog
        open={pending?.action === "rollback"}
        onClose={() => { if (!executing) close(); }}
        dismissible={!executing}
      >
        <DialogContainer size="md">
          <DialogPanel>
            <DialogHeader>
              <DialogIcon>
                <RotateCcw size={19} />
              </DialogIcon>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-3 text-sm">
              {!pending?.checkpoint.destructive && <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={includeFiles} disabled={executing || pending?.checkpoint.transcriptOnly}
                  onChange={(event) => changeFilePolicy(event.target.checked)} className="mt-1 accent-[var(--accent)]" />
                <span>{zh ? "同时撤销本会话记录的未提交文件变更" : "Also undo this session’s recorded uncommitted file changes"}</span>
              </label>}
              {pending?.checkpoint.transcriptOnly && <p className="text-xs text-muted-foreground">
                {zh ? "此边界由旧消息补建：仅恢复会话历史并重建上下文，不恢复当时的工作状态或文件。" : "This boundary was reconstructed from older messages. It restores conversation history and rebuilds context, without historical work state or file restoration."}
              </p>}
              {pending?.checkpoint.destructive && <p className="text-xs text-danger">
                {zh ? "后续消息和执行记录将被永久删除，工作区文件保持不变。" : "Later messages and execution records will be permanently deleted. Workspace files remain unchanged."}
              </p>}
              {!includeFiles && <p className="text-xs text-muted-foreground">
                {zh ? "仅裁剪会话历史，已有工作目录中的文件保持不变。" : "Trim conversation only; files in the existing workspace remain unchanged."}
              </p>}
              {!preview && !error && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Spinner size="sm" />
                  {zh ? "正在检查消息和文件…" : "Checking messages and files…"}
                </div>
              )}
              {preview && (
                <>
                  <p className="text-muted-foreground">
                    {zh
                      ? pending?.checkpoint.destructive ? `永久删除 ${preview.removedMessages} 条后续消息` : `截断 ${preview.removedMessages} 条消息 · 恢复 ${preview.files.length} 个文件`
                      : pending?.checkpoint.destructive ? `Permanently remove ${preview.removedMessages} later messages` : `Remove ${preview.removedMessages} messages · restore ${preview.files.length} files`}
                  </p>
                  {includeFiles && preview.files.length > 0 && (
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
                  {includeFiles && (
                    outOfScope.length > 0 || preview.warnings?.length
                  ) && (
                    <p
                      className="text-xs text-muted-foreground"
                      role="status"
                      title={[...outOfScope, ...(preview.warnings ?? [])].join("\n")}
                    >
                      {outOfScope.length > 0
                        ? zh
                          ? `另有 ${outOfScope.length} 项变更不在回滚范围，将保留。`
                          : `${outOfScope.length} out-of-scope changes will be preserved.`
                        : zh
                          ? "部分变更不在回滚范围，将保留。"
                          : "Some changes are out of scope and will be preserved."}
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
                </>
              )}
              {error && (
                <p role="alert" className="break-words text-danger">
                  {error}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => close()}
                disabled={executing}
              >
                {zh ? "取消" : "Cancel"}
              </Button>
              <Button
                size="sm"
                variant="danger"
                pending={executing}
                disabled={
                  !preview?.canApply || executing
                }
                onClick={() => void confirm()}
              >
                {title}
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogContainer>
      </Dialog>
    </HistoryContext.Provider>
  );
}
