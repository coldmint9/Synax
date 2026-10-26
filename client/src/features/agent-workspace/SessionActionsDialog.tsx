import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { agentRuntimeApi, type AgentSession } from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";
import { useNotificationStore } from "../../shared/state/notificationStore";
import { Button } from "../../shared/ui/ui/Button";
import { Dialog, DialogBody, DialogContainer, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "../../shared/ui/ui/Dialog";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { getSessionDisplayTitle } from "./useSessionDisplayTitle";
import { sessionPath, sessionsPath, workflowSessionsPath } from "./sessionRoutes";

export type SessionAction = "fork" | "rename" | "delete";
export type SessionActionTarget = AgentSession;
export type SessionActionRequest = { kind: SessionAction; session: SessionActionTarget };

export function SessionActionsDialog({ request, onClose, onComplete }: {
  request: SessionActionRequest;
  onClose: () => void;
  onComplete: () => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const { kind, session } = request;
  const title = getSessionDisplayTitle(session, "", locale);
  const [name, setName] = useState(title);
  const [workspaceMode, setWorkspaceMode] = useState<"reuse_worktree" | "new_worktree">("reuse_worktree");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const attempt = useRef<{ mode: string; id: string } | null>(null);
  const id = useId();
  const navigate = useNavigate();
  const location = useLocation();
  const currentLocation = useRef(location.key);
  currentLocation.current = location.key;
  const actionLabel = kind === "fork" ? (zh ? "全量 Fork 新会话" : "Fork entire conversation")
    : kind === "rename" ? (zh ? "重命名会话" : "Rename conversation") : (zh ? "永久删除会话" : "Delete conversation permanently");
  const close = () => { if (!inFlight.current) onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current || (kind === "rename" && !name.trim())) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const origin = location.key;
    const store = useAgentSessionStore.getState();
    try {
      if (kind === "rename") {
        await agentRuntimeApi.renameSession(session.id, name.trim());
        await store.syncSessionSummary(session.id);
      } else if (kind === "fork") {
        if (attempt.current?.mode !== workspaceMode) attempt.current = { mode: workspaceMode, id: crypto.randomUUID() };
        const result = await agentRuntimeApi.forkSession(session.id, { requestId: attempt.current.id, workspaceMode });
        await store.syncSessionSummary(result.sessionId);
        if (mounted.current && currentLocation.current === origin && useAgentSessionStore.getState().projectId === session.projectId) {
          store.openPanel(result.sessionId);
          navigate(sessionPath(session.projectId, result.sessionId));
        }
      } else {
        const removed = await store.permanentlyDeleteSession(session.id);
        const selected = new URLSearchParams(location.search).get("session");
        if (mounted.current && currentLocation.current === origin && selected && removed.includes(selected)
          && useAgentSessionStore.getState().projectId === session.projectId) {
          navigate(location.pathname.endsWith("/workflows") ? workflowSessionsPath(session.projectId) : sessionsPath(session.projectId));
        }
      }
      useNotificationStore.getState().push({ type: "success", message: kind === "fork"
        ? (zh ? "已创建完整会话副本" : "Conversation forked") : kind === "rename"
          ? (zh ? "会话已重命名" : "Conversation renamed") : (zh ? "会话已永久删除" : "Conversation permanently deleted") });
      if (mounted.current) { onComplete(); onClose(); }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <Dialog open onClose={close} dismissible={!busy} role={kind === "delete" ? "alertdialog" : "dialog"}>
    <DialogContainer size="sm"><DialogPanel>
      <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <DialogHeader><DialogTitle>{actionLabel}</DialogTitle></DialogHeader>
        <DialogBody className="space-y-3 text-sm">
          {kind === "rename" ? <>
            <label htmlFor={`${id}-name`}>{zh ? "会话名称" : "Conversation name"}</label>
            <input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} maxLength={200}
              autoFocus onFocus={(event) => event.target.select()} disabled={busy} required
              aria-describedby={error ? `${id}-error` : undefined}
              className="w-full rounded-lg border border-border bg-background p-2 text-sm" />
          </> : kind === "fork" ? <>
            <DialogDescription>{zh ? `复制「${title}」的全部已保存历史、附件和上下文，创建可独立继续的新会话。` : `Copy all saved history, attachments and context from “${title}” into a new conversation.`}</DialogDescription>
            <fieldset disabled={busy} className="space-y-2">
              <legend className="mb-2 font-medium">{zh ? "新会话的工作目录" : "Workspace for the new conversation"}</legend>
              <label className="flex items-center gap-2"><input type="radio" name={`${id}-workspace`} checked={workspaceMode === "reuse_worktree"} onChange={() => setWorkspaceMode("reuse_worktree")} />{zh ? "使用现有工作目录" : "Use existing workspace"}</label>
              <label className="flex items-center gap-2"><input type="radio" name={`${id}-workspace`} checked={workspaceMode === "new_worktree"} onChange={() => setWorkspaceMode("new_worktree")} />{zh ? "创建新的 Git 工作树" : "Create a new Git worktree"}</label>
            </fieldset>
            <p className="text-xs text-muted-foreground">{workspaceMode === "reuse_worktree"
              ? (zh ? "两段会话独立保存，共享当前工作目录中的文件。" : "Conversations are stored independently and share workspace files.")
              : (zh ? "需要 Git 仓库，将创建独立工作树；当前未提交的文件变更不会复制。" : "Requires a Git repository. Uncommitted file changes are not copied to the new worktree.")}</p>
          </> : <DialogDescription>{zh
            ? `永久删除「${title}」及其所有子会话？正在运行的任务会先停止，消息、执行记录和会话附件将被清除，无法恢复。工作目录中的文件会保留。`
            : `Permanently delete “${title}” and all its child conversations? Running tasks will stop, and messages, execution records and session attachments will be removed. This cannot be undone. Workspace files are kept.`}</DialogDescription>}
          {error ? <p id={`${id}-error`} role="alert" data-error-toast="off" className="break-words text-danger">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy} autoFocus={kind === "delete"}>{zh ? "取消" : "Cancel"}</Button>
          <Button type="submit" variant={kind === "delete" ? "danger" : "primary"} pending={busy} disabled={busy || (kind === "rename" && !name.trim())}>
            {kind === "rename" ? (zh ? "保存" : "Save") : actionLabel}
          </Button>
        </DialogFooter>
      </form>
    </DialogPanel></DialogContainer>
  </Dialog>;
}
