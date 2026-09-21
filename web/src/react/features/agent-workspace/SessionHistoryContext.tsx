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
  type HistoryPreview,
  type HistorySummary,
  type MessageCheckpoint,
} from "../../../lib/api/conversationHistory";
import type {
  AgentRuntimeMessage,
  AgentSession,
} from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";
import { useAgentSessionStore } from "./state/agentSessionStore";

interface ContextValue {
  reason: string | null;
  busy: boolean;
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
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!sessionId) return;
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
  useEffect(() => subscribe({ events: { session_checkpoint_changed: e => { if (JSON.parse(e.data).sessionId === sessionId) void refresh(); } } }), [sessionId, refresh]);
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
      if (!sessionId || resolver.current) return false;
      const epoch = ++requestEpoch.current;
      setPending({
        action,
        checkpoint,
        message,
        requestId: crypto.randomUUID(),
        sessionId,
      });
      setPreview(null);
      setError(null);
      const result = new Promise<boolean>((resolve) => {
        resolver.current = resolve;
      });
      void conversationHistoryApi
        .preview(sessionId, checkpoint.id, action)
        .then((value) => {
          if (epoch === requestEpoch.current) setPreview(value);
        })
        .catch((e) => {
          if (epoch === requestEpoch.current) setError((e as Error).message);
        });
      return result;
    },
    [sessionId],
  );
  const confirm = async () => {
    if (!pending || !preview || executing || !preview.canApply) return;
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
        session &&
        [
          "running",
          "queued",
          "stopping",
          "waiting_permission",
          "waiting_input",
        ].includes(session.status)
          ? zh
            ? "请先停止当前运行及后台写进程"
            : "Stop the active execution and background writers first"
          : summary && summary.sessionId === sessionId
            ? summary.reason
            : loadError ||
              (zh ? "正在检查历史快照" : "Checking history checkpoints"),
      busy: Boolean(pending),
      request,
      checkpoint: (messageId, stepId) => {
        if (!summary || summary.sessionId !== sessionId) return undefined;
        if (messageId?.startsWith("user-input-"))
          return summary.checkpoints.find((c) => c.initialInput);
        return summary.checkpoints.find((c) =>
          messageId
            ? c.messageId === messageId
            : stepId && c.kind === "reply" && c.stepId === stepId,
        );
      },
    }),
    [session, sessionId, summary, loadError, pending, request, zh],
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
      {summary?.recoveryRequired && <div role="alert" className="mx-auto my-2 flex max-w-3xl items-center gap-3 rounded-xl border border-warning/25 bg-warning/5 p-3 text-sm">
        <span>{zh ? "上一次历史操作需要恢复，完成前已暂停本工作区的写入。" : "A previous history operation needs recovery. Workspace writes are fenced until it is resolved."}</span>
        <Button size="sm" variant="secondary" isPending={executing} onPress={() => {
          if (!sessionId) return;
          setExecuting(true);
          void conversationHistoryApi.recover(sessionId).then(() => { setLoadError(null); void refresh(); }).catch(e => setLoadError((e as Error).message)).finally(() => setExecuting(false));
        }}>{zh ? "恢复" : "Recover"}</Button>
        {loadError && <span className="text-danger">{loadError}</span>}
      </div>}
      {children}
      <Modal.Backdrop
        isOpen={Boolean(pending)}
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
                    ? "在独立工作目录中继续，保留此回复之前的上下文与文件。原会话不会改变。"
                    : "Continue with this history and files in an isolated workspace. The original stays unchanged."
                  : zh
                    ? "后续消息将被截断，并撤销这些轮次的文件改动。与你或其他会话的修改冲突时，操作会停止。"
                    : "Later messages and their file changes will be removed. Conflicts with your edits or other sessions stop the operation."}
              </p>
              {!preview && !error && (
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
                        ? `隔离复制 ${preview.files.length} 个文件`
                        : `Copy ${preview.files.length} files into isolation`
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
                    {zh
                      ? "不包含依赖、缓存、密钥、Git 内部数据。不会撤销外部数据库或网络操作。"
                      : "Excludes dependencies, caches, credentials and Git internals. External database and network effects are not reversible."}
                    {fork &&
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
                isDisabled={!preview?.canApply || executing}
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
