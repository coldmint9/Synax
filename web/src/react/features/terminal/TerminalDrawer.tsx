import { useCallback, useEffect, useRef, useState } from "react";
import {
  LoaderCircle,
  Maximize2,
  Minimize2,
  Plus,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import {
  projectApi,
  type ProjectWorkspaceRoot,
} from "../../../lib/api/project";
import { agentRuntimeApi } from "../../../lib/api/agentRuntime";
import { terminalApi } from "../../../lib/api/terminal";
import { useLocale } from "../../../hooks/useLocale";
import { useSessionWorkspaceStore } from "../agent-workspace/state/sessionWorkspaceStore";
import { AppSelect } from "../../components/AppSelect";
import { TerminalViewport } from "./TerminalViewport";
import {
  terminalChanged,
  useTerminalStore,
  type LegacyTerminal,
} from "./terminalStore";
import "./terminal.css";

function directoryName(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function LegacyTerminalView({
  legacy,
  id,
  visible,
}: {
  legacy: LegacyTerminal;
  id: string;
  visible: boolean;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [command, setCommand] = useState(legacy.process.command),
    [cwd, setCwd] = useState(legacy.cwd);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    if (cwd) return;
    let current = true;
    void agentRuntimeApi
      .getSessionEnvironment(legacy.sessionId)
      .then((env) => {
        if (current) setCwd(env.workspacePath);
      })
      .catch((err) => {
        if (current) setError(String(err));
      });
    return () => {
      current = false;
    };
  }, [legacy.sessionId]);
  return (
    <section className="terminal-legacy" hidden={!visible}>
      <h3>
        {zh
          ? "此服务尚未接入交互终端"
          : "This service was started without a PTY"}
      </h3>
      <p>
        {zh
          ? "旧服务没有保留可交互输入或完整历史输出。当前进程保持不变；确认命令和目录后，可手动重启到终端。原来的自定义环境变量无法恢复，新进程使用当前环境。"
          : "Interactive input and complete output were not retained. The existing process is untouched. Review its command and directory before restarting it in a terminal. The current environment is used; old overrides cannot be recovered."}
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            const item = await terminalApi.restartLegacy(
              legacy.sessionId,
              legacy.process.id,
              { command, cwd, requestId: requestId.current },
            );
            useTerminalStore.getState().accept(item, id);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {zh ? "启动目录" : "Starting directory"}
          <input
            aria-label={zh ? "重启工作目录" : "Restart directory"}
            value={cwd}
            onChange={(event) => {
              requestId.current = crypto.randomUUID();
              setCwd(event.target.value);
            }}
            required
            disabled={busy}
          />
        </label>
        <label>
          {zh ? "启动命令" : "Command"}
          <textarea
            aria-label={zh ? "重启命令" : "Restart command"}
            value={command}
            onChange={(event) => {
              requestId.current = crypto.randomUUID();
              setCommand(event.target.value);
            }}
            required
            disabled={busy}
          />
        </label>
        {error && (
          <p className="terminal-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !command.trim() || !cwd.trim()}>
          {busy
            ? zh
              ? "重启中…"
              : "Restarting…"
            : legacy.process.state === "closed"
              ? zh
                ? "确认并在终端重新运行"
                : "Confirm and run in terminal"
              : zh
                ? "确认停止旧服务并重启到终端"
                : "Confirm stop and restart in terminal"}
        </button>
      </form>
    </section>
  );
}

export function TerminalDrawer({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string | null;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const open = useTerminalStore((state) => state.open),
    height = useTerminalStore((state) => state.height),
    maximized = useTerminalStore((state) => state.maximized);
  const tabs = useTerminalStore((state) => state.tabs),
    activeId = useTerminalStore((state) => state.activeId);
  const pending = useTerminalStore((state) => state.pending),
    error = useTerminalStore((state) => state.error);
  const [roots, setRoots] = useState<ProjectWorkspaceRoot[]>([]),
    [rootId, setRootId] = useState("");
  const [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState<string | null>(null);
  const active = tabs.find((tab) => tab.id === activeId);
  const selectedRoot = useSessionWorkspaceStore((state) =>
    sessionId
      ? (state.sessions[sessionId]?.selectedRootId ??
        state.sessions[sessionId]?.tabs.find(
          (tab) => tab.id === state.sessions[sessionId]?.activeTabId,
        )?.rootId)
      : undefined,
  );
  useEffect(() => {
    let current = true;
    setRoots([]);
    setRootId("");
    if (!projectId) return;
    const promise = sessionId
      ? agentRuntimeApi.getSessionEnvironment(sessionId).then((env) =>
          (env.repositories ?? []).map((root) => ({
            id: root.rootId,
            name: root.name,
            path: root.workspacePath,
            role: root.role,
            status:
              root.status === "missing"
                ? ("missing" as const)
                : ("available" as const),
          })),
        )
      : projectApi.getWorkspace(projectId).then((data) => data.roots);
    void promise
      .then((items) => {
        if (current) {
          setRoots(items);
          setRootId(
            items.find((item) => item.id === selectedRoot)?.id ??
              items.find((item) => item.role === "primary")?.id ??
              items[0]?.id ??
              "",
          );
        }
      })
      .catch((err) => {
        if (current)
          setActionError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      current = false;
    };
  }, [projectId, sessionId, selectedRoot]);
  const create = useCallback(() => {
    if (projectId)
      void useTerminalStore
        .getState()
        .create(
          projectId,
          rootId || selectedRoot || projectId,
          sessionId || undefined,
        );
  }, [projectId, rootId, sessionId, selectedRoot]);
  useEffect(() => {
    const show = () => useTerminalStore.getState().toggle();
    document.addEventListener("terminal:new", create);
    document.addEventListener("terminal:toggle", show);
    return () => {
      document.removeEventListener("terminal:new", create);
      document.removeEventListener("terminal:toggle", show);
    };
  }, [create]);
  // The drawer owns manually created terminals. Hydration uses the terminal
  // API directly and never reads the background-services list.
  const autoCreated = useRef(false);
  useEffect(() => {
    if (!open) {
      autoCreated.current = false;
      return;
    }
    if (autoCreated.current || !projectId || pending > 0 || tabs.length) return;
    autoCreated.current = true;
    void useTerminalStore
      .getState()
      .hydrate(projectId)
      .then(() => {
        if (!useTerminalStore.getState().tabs.length) create();
      });
  }, [open, projectId, pending, tabs.length, create]);
  const setNativeFocus = (focused: boolean) =>
    (window as any).electronAPI?.setTerminalFocus?.(focused);
  useEffect(() => {
    if (!open) setNativeFocus(false);
    return () => {
      setNativeFocus(false);
    };
  }, [open]);
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanup.current?.();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startY = event.clientY,
      initial =
        event.currentTarget.parentElement!.getBoundingClientRect().height;
    const move = (next: PointerEvent) =>
      useTerminalStore
        .getState()
        .setHeight(
          Math.min(window.innerHeight - 120, initial + startY - next.clientY),
        );
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      resizeCleanup.current = null;
    };
    resizeCleanup.current = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  const stop = async () => {
    if (!active?.terminal || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      useTerminalStore
        .getState()
        .update(await terminalApi.stop(active.terminal));
      terminalChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!active?.terminal || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await terminalApi.remove(active.terminal);
      useTerminalStore.getState().closeTab(active.id);
      terminalChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className={`terminal-drawer${maximized ? " terminal-drawer--maximized" : ""}`}
      hidden={!open}
      aria-label={zh ? "终端抽屉" : "Terminal drawer"}
      style={{ height: maximized ? undefined : height }}
      onFocusCapture={() => setNativeFocus(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setNativeFocus(false);
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        className="terminal-drawer-resizer"
        hidden={maximized}
        role="separator"
        tabIndex={0}
        aria-label={zh ? "调整终端高度" : "Resize terminal"}
        aria-orientation="horizontal"
        aria-valuenow={height}
        aria-valuemin={160}
        aria-valuemax={800}
        onPointerDown={resize}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            useTerminalStore
              .getState()
              .setHeight(height + (event.key === "ArrowUp" ? 32 : -32));
          }
        }}
      />
      <header className="terminal-drawer-header">
        <span className="terminal-drawer-heading">
          <TerminalIcon size={14} />
          {zh ? "终端" : "Terminal"}
        </span>
        <div
          className="terminal-tabs"
          role="tablist"
          aria-label={zh ? "终端会话" : "Terminal sessions"}
        >
          {tabs.map((tab, index) => (
            <div
              className="terminal-tab"
              key={tab.id}
              data-active={tab.id === activeId}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeId}
                onClick={() => useTerminalStore.getState().activate(tab.id)}
                title={tab.terminal?.cwd ?? tab.legacy?.process.command}
              >
                <span
                  className={`terminal-tab-dot ${tab.terminal?.state === "active" ? "terminal-tab-dot--live" : ""}`}
                />
                <span>
                  {tab.terminal?.kind === "terminal"
                    ? directoryName(tab.terminal.cwd) || tab.terminal.title
                    : (tab.terminal?.command ?? tab.legacy?.process.command)}
                </span>
              </button>
              <button
                type="button"
                className="terminal-icon"
                aria-label={`${zh ? "关闭终端视图" : "Close terminal view"} ${index + 1}`}
                title={
                  zh
                    ? "关闭视图，不停止进程"
                    : "Close view, keep process running"
                }
                onClick={() => useTerminalStore.getState().closeTab(tab.id)}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-drawer-actions">
          {roots.length > 1 && (
            <AppSelect
              aria-label={zh ? "终端项目目录" : "Terminal workspace"}
              className="terminal-root-select"
              fullWidth={false}
              value={rootId || null}
              onChange={(value) => value && setRootId(value)}
              options={roots.map((root) => ({
                key: root.id,
                label: root.name,
                isDisabled: root.status === "missing",
              }))}
            />
          )}
          <button
            type="button"
            className="terminal-icon"
            onClick={create}
            disabled={!projectId || pending > 0}
            title={zh ? "新增终端" : "New terminal"}
            aria-label={zh ? "新增终端" : "New terminal"}
          >
            <Plus size={15} />
          </button>
          {active?.terminal && (
            <>
              <button
                type="button"
                className="terminal-icon"
                onClick={() => void stop()}
                disabled={busy || active.terminal.state === "closed"}
                title={
                  zh ? "结束终端及其子进程" : "End terminal and its children"
                }
                aria-label={zh ? "结束终端" : "End terminal"}
              >
                {busy ? (
                  <LoaderCircle size={13} className="animate-spin" />
                ) : (
                  <Square size={13} />
                )}
              </button>
              <button
                type="button"
                className="terminal-icon"
                onClick={() => void remove()}
                disabled={busy || active.terminal.state !== "closed"}
                title={
                  zh ? "删除已结束的终端记录" : "Delete exited terminal record"
                }
                aria-label={zh ? "删除终端记录" : "Delete terminal record"}
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
          <button
            type="button"
            className="terminal-icon"
            onClick={() => useTerminalStore.getState().maximize()}
            aria-label={
              maximized
                ? zh
                  ? "还原终端大小"
                  : "Restore terminal"
                : zh
                  ? "最大化终端"
                  : "Maximize terminal"
            }
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            className="terminal-icon"
            onClick={() => useTerminalStore.getState().hide()}
            aria-label={zh ? "收起终端" : "Hide terminal"}
            title={zh ? "收起，不停止进程" : "Hide, keep processes running"}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      {(error || actionError) && (
        <div className="terminal-error" role="alert">
          {error || actionError}
          <button
            onClick={() => {
              useTerminalStore.getState().clearError();
              setActionError(null);
            }}
            aria-label={zh ? "关闭终端错误" : "Dismiss terminal error"}
          >
            ×
          </button>
        </div>
      )}
      <div className="terminal-drawer-content">
        {pending > 0 && (
          <div className="terminal-placeholder" role="status">
            <LoaderCircle size={16} className="animate-spin" />
            {zh ? "正在连接终端…" : "Connecting terminal…"}
          </div>
        )}
        {!tabs.length && !pending && (
          <div className="terminal-placeholder">
            <TerminalIcon size={24} />
            <p>
              {zh
                ? "打开一个终端，在当前项目中运行命令。"
                : "Open a terminal to work in your project."}
            </p>
            <button type="button" disabled={!projectId} onClick={create}>
              {zh ? "新增终端" : "New terminal"}
            </button>
          </div>
        )}
        {tabs.map((tab) =>
          tab.terminal ? (
            <TerminalViewport
              key={tab.id}
              session={tab.terminal}
              visible={open && tab.id === activeId && !pending}
            />
          ) : (
            <LegacyTerminalView
              key={tab.id}
              id={tab.id}
              legacy={tab.legacy}
              visible={open && tab.id === activeId && !pending}
            />
          ),
        )}
      </div>
    </section>
  );
}
