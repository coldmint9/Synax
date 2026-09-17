import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Square, Terminal } from "lucide-react";
import {
  agentRuntimeApi,
  type SessionBackgroundProcess,
} from "../../../lib/api/agentRuntime";
import { subscribe } from "../../../lib/api/runtimeEventBus";
import { useLocale } from "../../../hooks/useLocale";
import { ActivityStatus } from "../../components/beautiful-ui/ActivityStatus";

export function SessionBackgroundProcesses({
  sessionId,
}: {
  sessionId: string;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [items, setItems] = useState<SessionBackgroundProcess[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const epoch = useRef(0);
  const active = useRef(sessionId);
  active.current = sessionId;
  const stoppingRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let loading = false;
    setItems([]);
    setError(null);
    setLoadError(null);
    setStopping(null);
    stoppingRef.current = null;
    const reload = async () => {
      if (loading || disposed) return;
      loading = true;
      const requestEpoch = ++epoch.current;
      try {
        const result = await agentRuntimeApi.listSessionProcesses(sessionId);
        if (
          !disposed &&
          active.current === sessionId &&
          requestEpoch === epoch.current
        ) {
          setItems(result.items);
          setLoadError(null);
        }
      } catch (err) {
        if (!disposed && active.current === sessionId)
          setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        loading = false;
      }
    };
    void reload();
    const timer = window.setInterval(() => void reload(), 3000);
    const unsubscribe = subscribe({
      events: {
        session_process_changed: (event) => {
          try {
            if (JSON.parse(event.data).sessionId === sessionId) void reload();
          } catch {
            /* ignore malformed events */
          }
        },
      },
    });
    return () => {
      disposed = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [sessionId]);

  async function stop(id: string) {
    if (stoppingRef.current) return;
    stoppingRef.current = id;
    setStopping(id);
    setError(null);
    try {
      const result = await agentRuntimeApi.stopSessionProcess(sessionId, id);
      if (active.current === sessionId) {
        epoch.current++;
        setItems(result.items);
      }
    } catch (err) {
      if (active.current === sessionId)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (active.current === sessionId) {
        stoppingRef.current = null;
        setStopping(null);
      }
    }
  }

  if (!items.length && !error && !loadError) return null;
  return (
    <section
      className="bui-processes"
      aria-label={zh ? "后台服务" : "Background services"}
    >
      <header>
        <Terminal size={13} aria-hidden />
        <strong>{zh ? "后台服务" : "Background services"}</strong>
        <span>{items.filter((item) => item.state !== "closed").length}</span>
      </header>
      {(error || loadError) && (
        <p role="alert" className="bui-approval-error">
          {error || loadError}
        </p>
      )}
      {items.map((item) => {
        const live = item.state !== "closed";
        return (
          <div className="bui-process-row" key={item.id}>
            <div>
              <pre title={item.command}>{item.command}</pre>
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
            {live && (
              <button
                type="button"
                disabled={stopping !== null}
                className="bui-process-stop"
                aria-label={`${zh ? "终止" : "Stop"} ${item.command}`}
                title={
                  zh
                    ? "终止进程及其子进程"
                    : "Stop this process and its children"
                }
                onClick={() => void stop(item.id)}
              >
                {stopping === item.id ? (
                  <LoaderCircle
                    size={13}
                    className="bui-status-spinner"
                    aria-hidden
                  />
                ) : (
                  <Square size={12} aria-hidden />
                )}
                <span>{zh ? "终止" : "Stop"}</span>
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
