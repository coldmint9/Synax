import { useTerminalStore } from "../terminal/terminalStore";
import { useSessionWorkspaceStore } from "./sessionWorkspaceStore";
import { useEffect, useRef, useState } from "react";
import {
  Plus,
  LoaderCircle,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  agentRuntimeApi,
  type SessionBackgroundProcess,
  type SessionEnvironment,
} from "../../../lib/api/agentRuntime";
import { subscribe } from "../../../lib/api/runtimeEventBus";
import { useLocale } from "../../../hooks/useLocale";
import { ActivityStatus } from "../../components/beautiful-ui/ActivityStatus";
import { WorkspaceSection } from "./WorkspaceSection";

export function SessionBackgroundProcesses({
  sessionId,
  environment,
}: {
  sessionId: string;
  environment?: SessionEnvironment | null;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [items, setItems] = useState<SessionBackgroundProcess[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{
    id: string;
    action: "stop" | "delete";
  } | null>(null);
  const drawerOpen = useTerminalStore(state => state.open);
  const activeTerminal = useTerminalStore(state => state.activeId);
  const selectedRootId = useSessionWorkspaceStore(state => state.sessions[sessionId]?.selectedRootId ?? state.sessions[sessionId]?.tabs.find(tab => tab.id === state.sessions[sessionId]?.activeTabId)?.rootId);
  const root = environment?.repositories?.find(item => item.rootId === selectedRootId) ?? environment?.repositories?.find(item => item.role === "primary");
  const generation = useRef(0);
  const revision = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    let disposed = false;
    let loading = false;
    let queued = false;
    setItems([]);
    setError(null);
    setLoadError(null);
    setBusy(null);

    busyRef.current = false;
    const reload = async () => {
      if (disposed) return;
      if (loading) {
        queued = true;
        return;
      }
      loading = true;
      const requestRevision = revision.current;
      try {
        const result = await agentRuntimeApi.listSessionProcesses(sessionId);
        if (!disposed && requestRevision === revision.current) {
          setItems(result.items);
          setLoadError(null);
        }
      } catch (err) {
        if (!disposed)
          setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        loading = false;
        if (queued && !disposed) {
          queued = false;
          void reload();
        }
      }
    };
    void reload();
    const onTerminalChanged = () => void reload();
    document.addEventListener("terminal:changed", onTerminalChanged);
    const timer = window.setInterval(() => void reload(), 30_000);
    const unsubscribe = subscribe({
      events: {
        session_process_changed: (event) => {
          try {
            if (JSON.parse(event.data).sessionId === sessionId) void reload();
          } catch {
            /* Malformed SSE. */
          }
        },
      },
    });
    return () => {
      disposed = true;
      if (generation.current === current) generation.current++;
      window.clearInterval(timer);
      document.removeEventListener("terminal:changed", onTerminalChanged);
      unsubscribe();
    };
  }, [sessionId]);

  async function act(id: string, action: "stop" | "delete") {
    if (busyRef.current) return;
    const current = generation.current;
    busyRef.current = true;
    setBusy({ id, action });
    setError(null);
    revision.current++;
    try {
      const result = await (
        action === "stop"
          ? agentRuntimeApi.stopSessionProcess
          : agentRuntimeApi.deleteSessionProcess
      )(sessionId, id);
      if (current === generation.current) {
        revision.current++;
        setItems(result.items);
        if (action === "delete") { useTerminalStore.getState().closeTab(id); useTerminalStore.getState().closeTab(`legacy:${id}`); }
      }
    } catch (err) {
      if (current === generation.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (current === generation.current) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  }

  return (
    <WorkspaceSection
      className={`bui-processes${items.length ? "" : " bui-processes--empty"}`}
      storageKey={`${sessionId}:services`}
      icon={<Terminal size={13} />}
      title={zh ? "后台服务" : "Background services"}
      count={items.length}
      actions={<button type="button" className="bui-process-new" disabled={!environment?.projectId}
        aria-label={zh ? "新增终端" : "New terminal"}
        onClick={() => environment && void useTerminalStore.getState().create(environment.projectId, root?.rootId ?? environment.projectId, sessionId)}><Plus size={11} />{zh ? "新增终端" : "New terminal"}</button>}
      summary={items.length ? (items.some(item => item.state !== "closed")
        ? `${items.filter(item => item.state !== "closed").length} ${zh ? "运行中" : "running"}`
        : (zh ? "均已结束" : "All stopped")) : null}
    >
      {(error || loadError) && (
        <p role="alert" className="bui-approval-error">
          {error || loadError}
        </p>
      )}
      {!items.length && !loadError && (
        <p className="ws-empty">
          {zh ? "暂无后台服务" : "No background services"}
        </p>
      )}
      {items.map((item) => {
        const live = item.state !== "closed";
        const open = drawerOpen && (activeTerminal === item.terminalId || activeTerminal === `legacy:${item.id}`);
        return (
          <div className="bui-process-row" key={item.id}>
            <div className="bui-process-info">
              <button
                type="button"
                className="bui-process-command"
                data-terminal-open={item.terminalId}
                aria-expanded={open}
                onClick={() => {
                  const projectId = item.projectId ?? environment?.projectId;
                  if (!projectId) return;
                  if (item.terminalId) void useTerminalStore.getState().openTerminal(projectId, item.terminalId);
                  else useTerminalStore.getState().openLegacy({ sessionId, projectId, process: item, cwd: root?.workspacePath ?? environment?.workspacePath ?? "" });
                }}
                title={item.command}
              >
                <Terminal size={11} aria-hidden />
                <code>{item.command}</code>
              </button>
              <span className="bui-process-meta">
                <ActivityStatus
                  status={
                    live
                      ? item.state === "preparing"
                        ? "queued"
                        : item.state === "unconfirmed"
                          ? "blocked"
                          : "running"
                      : item.exitCode === null
                        ? "cancelled"
                        : item.exitCode === 0
                          ? "completed"
                          : "failed"
                  }
                />
                {item.pid && <span>PID {item.pid}</span>}
              </span>
            </div>
            <div className="bui-process-actions">
              {live && (
                <button
                  type="button"
                  disabled={busy !== null}
                  className="ws-icon-button"
                  aria-label={`${zh ? "终止" : "Stop"} ${item.command}`}
                  title={
                    zh ? "停止服务及其子进程" : "Stop service and its children"
                  }
                  onClick={() => void act(item.id, "stop")}
                >
                  {busy?.id === item.id && busy.action === "stop" ? (
                    <LoaderCircle size={12} className="animate-spin" />
                  ) : (
                    <Square size={12} />
                  )}
                </button>
              )}
              <button
                type="button"
                disabled={busy !== null || live}
                className="ws-icon-button bui-process-delete"
                aria-label={`${zh ? "删除记录" : "Delete record"} ${item.command}`}
                title={
                  live
                    ? zh
                      ? "先停止服务后删除记录"
                      : "Stop the service before deleting its record"
                    : zh
                      ? "删除记录（不删除文件）"
                      : "Delete record (keeps files)"
                }
                onClick={() => void act(item.id, "delete")}
              >
                {busy?.id === item.id && busy.action === "delete" ? (
                  <LoaderCircle size={12} className="animate-spin" />
                ) : (
                  <Trash2 size={12} />
                )}
              </button>
            </div>
          </div>
        );
      })}
    </WorkspaceSection>
  );
}
