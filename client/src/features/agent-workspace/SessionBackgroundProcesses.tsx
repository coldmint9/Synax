import { useTerminalStore } from "../terminal/terminalStore";
import { useSessionWorkspaceStore } from "./state/sessionWorkspaceStore";
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { PopoverGroup } from "@headlessui/react";
import {
  Popover,
  PopoverButton,
  PopoverPanel,
} from "@/shared/ui/ui/Popover";
import { LoaderCircle, Square, Terminal, Trash2 } from "lucide-react";
import {
  agentRuntimeApi,
  type SessionBackgroundProcess,
  type SessionEnvironment,
} from "../../adapters/transport/agentRuntime";
import { terminalApi } from "../../adapters/transport/terminal";
import { subscribe } from "../../adapters/transport/runtimeEventBus";
import { useLocale } from "../../shared/hooks/useLocale";
import { ActivityStatus } from "../../shared/ui/beautiful-ui/ActivityStatus";
import { WorkspaceSection } from "./WorkspaceSection";
import "./sessionBackgroundProcesses.css";

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
    action: "stop" | "delete" | "stop-delete";
  } | null>(null);
  const drawerOpen = useTerminalStore((state) => state.open);
  const activeTerminal = useTerminalStore((state) => state.activeId);
  const selectedRootId = useSessionWorkspaceStore(
    (state) =>
      state.sessions[sessionId]?.selectedRootId ??
      state.sessions[sessionId]?.tabs.find(
        (tab) => tab.id === state.sessions[sessionId]?.activeTabId,
      )?.rootId,
  );
  const root =
    environment?.repositories?.find((item) => item.rootId === selectedRootId) ??
    environment?.repositories?.find((item) => item.role === "primary");
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
      unsubscribe();
    };
  }, [sessionId]);

  async function act(id: string, action: "stop" | "delete" | "stop-delete") {
    if (busyRef.current) return;
    const current = generation.current;
    busyRef.current = true;
    setBusy({ id, action });
    setError(null);
    revision.current++;
    try {
      if (action === "stop-delete") {
        const stopped = await agentRuntimeApi.stopSessionProcess(sessionId, id);
        if (current === generation.current) {
          revision.current++;
          setItems(stopped.items);
        }
      }
      const result = await (
        action === "stop"
          ? agentRuntimeApi.stopSessionProcess
          : agentRuntimeApi.deleteSessionProcess
      )(sessionId, id);
      if (current === generation.current) {
        revision.current++;
        setItems(result.items);
        if (action === "stop") {
          // A terminal view of the stopped service must follow immediately,
          // not wait for its next reconnect.
          const stopped = items.find((item) => item.id === id);
          const stoppedProject = stopped?.projectId ?? environment?.projectId;
          if (stopped?.terminalId && stoppedProject) {
            try {
              useTerminalStore
                .getState()
                .update(
                  await terminalApi.get(stoppedProject, stopped.terminalId),
                );
            } catch {
              /* The terminal view refreshes on its next connection. */
            }
          }
        }
        if (action !== "stop") {
          useTerminalStore.getState().closeTab(id);
          useTerminalStore.getState().closeTab(`legacy:${id}`);
        }
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

  // One click stops every live service and clears every service record;
  // plain terminals keep their shells.
  async function deleteAll() {
    if (busyRef.current) return;
    const current = generation.current;
    const targets = items.filter((item) => item.kind !== "terminal");
    if (!targets.length) return;
    busyRef.current = true;
    setBusy({ id: "*all*", action: "stop-delete" });
    setError(null);
    revision.current++;
    try {
      const outcomes = await Promise.allSettled(
        targets.map(async (item) => {
          if (item.state !== "closed")
            await agentRuntimeApi.stopSessionProcess(sessionId, item.id);
          await agentRuntimeApi.deleteSessionProcess(sessionId, item.id);
        }),
      );
      const result = await agentRuntimeApi.listSessionProcesses(sessionId);
      if (current === generation.current) {
        revision.current++;
        setItems(result.items);
        for (const item of targets) {
          useTerminalStore.getState().closeTab(item.id);
          useTerminalStore.getState().closeTab(`legacy:${item.id}`);
        }
        const failed = outcomes.find(
          (outcome) => outcome.status === "rejected",
        );
        if (failed)
          throw failed.reason instanceof Error
            ? failed.reason
            : new Error(String(failed.reason));
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

  const services = items.filter((item) => item.kind !== "terminal");
  if (!services.length) return null;

  return (
    <WorkspaceSection
      className="bui-processes"
      storageKey={`${sessionId}:services`}
      icon={<Terminal size={13} />}
      title={zh ? "后台服务" : "Background services"}
      count={services.length}
      actions={
        services.length > 0 && (
          <button
            type="button"
            className="ws-icon-button"
            disabled={busy !== null}
            aria-label={zh ? "删除所有服务" : "Delete all services"}
            title={
              zh
                ? "停止并删除所有服务记录"
                : "Stop and delete every service record"
            }
            onClick={() => void deleteAll()}
          >
            {busy?.id === "*all*" ? (
              <LoaderCircle size={13} className="animate-spin" />
            ) : (
              <Trash2 size={13} />
            )}
          </button>
        )
      }
    >
      {(error || loadError) && (
        <p role="alert" className="bui-approval-error">
          {error || loadError}
        </p>
      )}
      <PopoverGroup className="contents">
        {services.map((item) => {
          const live = item.state !== "closed";
          // Plain terminals have no service lifecycle: no status, no stop — the
          // delete button directly clears the terminal and its session.
          const plainTerminal = item.kind === "terminal";
          const livePorts = live && !plainTerminal ? (item.ports ?? []) : [];
          const deleteProps = {
            disabled: busy !== null,
            className: "ws-icon-button bui-process-delete",
            "aria-label": `${plainTerminal ? (zh ? "删除终端" : "Delete terminal") : zh ? "删除记录" : "Delete record"} ${item.command}`,
            title: plainTerminal
              ? zh
                ? "删除终端并清除该终端会话"
                : "Delete the terminal and clear its session"
              : live
                ? zh
                  ? "停止并删除记录"
                  : "Stop and delete record"
                : zh
                  ? "删除记录（不删除文件）"
                  : "Delete record (keeps files)",
          };
          const deleteIcon =
            busy?.id === item.id && busy.action !== "stop" ? (
              <LoaderCircle size={12} className="animate-spin" />
            ) : (
              <Trash2 size={12} />
            );
          const open =
            drawerOpen &&
            (activeTerminal === item.terminalId ||
              activeTerminal === `legacy:${item.id}`);
          return (
            <div
              className={`bui-process-row${livePorts.length ? " bui-process-row--ports" : ""}`}
              key={item.id}
            >
              <div className="bui-process-info">
                <button
                  type="button"
                  className="bui-process-command"
                  data-terminal-open={item.terminalId}
                  aria-expanded={open}
                  onClick={() => {
                    const projectId = item.projectId ?? environment?.projectId;
                    if (!projectId) return;
                    if (item.terminalId)
                      void useTerminalStore
                        .getState()
                        .openTerminal(projectId, item.terminalId);
                    else
                      useTerminalStore.getState().openLegacy({
                        sessionId,
                        projectId,
                        process: item,
                        cwd:
                          root?.workspacePath ??
                          environment?.workspacePath ??
                          "",
                      });
                  }}
                  title={item.command}
                >
                  <Terminal size={11} aria-hidden />
                  <code>{item.command}</code>
                </button>
                {!plainTerminal && (
                  <span className="bui-process-meta">
                    {/* Running is conveyed by the row colour alone; only
                      finished records get a status chip. */}
                    {!live && (
                      <ActivityStatus
                        status={
                          item.exitCode === null
                            ? "cancelled"
                            : item.exitCode === 0
                              ? "completed"
                              : "failed"
                        }
                      />
                    )}
                    {item.pid && <span>PID {item.pid}</span>}
                    {livePorts.map((port) => (
                      <span
                        key={port}
                        className="bui-process-port"
                        title={
                          zh ? `服务端口 :${port}` : `Service port :${port}`
                        }
                      >
                        :{port}
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <div className="bui-process-actions">
                {live && !plainTerminal && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    className="ws-icon-button"
                    aria-label={`${zh ? "终止" : "Stop"} ${item.command}`}
                    title={
                      zh
                        ? "停止服务及其子进程"
                        : "Stop service and its children"
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
                {live && !plainTerminal ? (
                  <DeleteConfirmation
                    key={`${sessionId}:${item.id}`}
                    triggerProps={deleteProps}
                    icon={deleteIcon}
                    zh={zh}
                    onConfirm={() => void act(item.id, "stop-delete")}
                  />
                ) : (
                  <button
                    {...deleteProps}
                    type="button"
                    onClick={() => void act(item.id, "delete")}
                  >
                    {deleteIcon}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </PopoverGroup>
    </WorkspaceSection>
  );
}

interface DeleteConfirmationProps {
  triggerProps: ButtonHTMLAttributes<HTMLButtonElement>;
  icon: ReactNode;
  zh: boolean;
  onConfirm: () => void;
}

function DeleteConfirmation(props: DeleteConfirmationProps) {
  return (
    <Popover>
      {({ open, close }) => (
        <DeleteConfirmationContent {...props} open={open} close={close} />
      )}
    </Popover>
  );
}

function DeleteConfirmationContent({
  triggerProps,
  icon,
  zh,
  onConfirm,
  open,
  close,
}: DeleteConfirmationProps & { open: boolean; close: () => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const hoverClose = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHoverClose = () => {
    if (hoverClose.current) clearTimeout(hoverClose.current);
    hoverClose.current = null;
  };
  const scheduleHoverClose = () => {
    cancelHoverClose();
    hoverClose.current = setTimeout(() => {
      hoverClose.current = null;
      // Keyboard users can continue a confirmation independently of the pointer.
      if (!panel.current?.contains(document.activeElement)) close();
    }, 250);
  };
  useEffect(
    () => () => {
      if (hoverClose.current) clearTimeout(hoverClose.current);
    },
    [],
  );
  useEffect(() => {
    if (open && triggerProps.disabled) close();
    if (!open) cancelHoverClose();
  }, [open, triggerProps.disabled, close]);
  return (
    <>
      <PopoverButton
        {...triggerProps}
        ref={trigger}
        onMouseEnter={() => {
          cancelHoverClose();
          // Headless UI's native trigger remains the only open-state authority.
          if (!open && !triggerProps.disabled) trigger.current?.click();
        }}
        onMouseLeave={scheduleHoverClose}
      >
        {icon}
      </PopoverButton>
      <PopoverPanel
        anchor={{ to: "top end", gap: 6, padding: 8 }}
        className="bui-process-confirm"
        onMouseEnter={cancelHoverClose}
        onMouseLeave={scheduleHoverClose}
        role="dialog"
        aria-label={zh ? "停止并删除？" : "Stop and delete?"}
      >
        <div ref={panel}>
          <h3 className="text-xs font-semibold">{zh ? "停止并删除？" : "Stop and delete?"}</h3>
          <p>
            {zh
              ? "将停止服务及其子进程，并删除记录。文件会保留。"
              : "Stop this service and its children, then delete the record. Files will be kept."}
          </p>
          <div className="bui-process-confirm-actions">
            <button type="button" onClick={() => close()}>
              {zh ? "取消" : "Cancel"}
            </button>
            <button
              type="button"
              className="bui-process-confirm-delete"
              disabled={triggerProps.disabled}
              onClick={() => {
                close();
                onConfirm();
              }}
            >
              {zh ? "停止并删除" : "Stop and delete"}
            </button>
          </div>
        </div>
      </PopoverPanel>
    </>
  );
}
