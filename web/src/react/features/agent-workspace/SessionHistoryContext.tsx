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
import { Dialog, DialogContainer, DialogPanel, DialogHeader, DialogIcon, DialogTitle, DialogBody, DialogFooter } from "@/react/components/ui/Dialog";
import { Spinner } from "@/react/components/ui/Display";
import { Button } from "@/react/components/ui/Button";
import { RotateCcw, AlertTriangle } from "lucide-react";
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
import { useNotificationStore } from "../../state/notificationStore";
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
  const forkInFlight = useRef(false);
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
      workspaceMode?: ForkWorkspaceMode,
    ): Promise<boolean> => {
      if (!sessionId || executing || resolver.current || forkInFlight.current) return false;
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
      setIncludeFiles(action !== "fork");
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
      await Promise.all([store.refreshSessions(), store.refreshDetail()]);
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
      busy: Boolean(pending) || executing,
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
      executing,
      zh,
      messages,
    ],
  );
  const title = zh ? "回滚到此处" : "Roll back to here";
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
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={includeFiles} disabled={executing}
                  onChange={(event) => changeFilePolicy(event.target.checked)} className="mt-1 accent-[var(--accent)]" />
                <span>{zh ? "同时撤销本会话记录的未提交文件变更" : "Also undo this session’s recorded uncommitted file changes"}</span>
              </label>
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
                      ? `截断 ${preview.removedMessages} 条消息 · 恢复 ${preview.files.length} 个文件`
                      : `Remove ${preview.removedMessages} messages · restore ${preview.files.length} files`}
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
