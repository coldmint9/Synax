import { useState } from "react";
import {
  agentRuntimeApi,
  type AgentSession,
} from "../../../lib/api/agentRuntime";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { useLocale } from "../../../hooks/useLocale";

export function RuntimeRecoveryPanel({ session }: { session: AgentSession }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const control = session.sessionMetadata?.runtimeControl as
    | { state?: string; reason?: string }
    | undefined;
  if (control?.state !== "unconfirmed") return null;
  return (
    <section
      aria-label={zh ? "执行恢复" : "Execution recovery"}
      className="mb-3 space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs"
    >
      <p className="font-medium">
        {zh ? "旧执行未能完全停止" : "Previous execution did not stop cleanly"}
      </p>
      <p className="text-muted-foreground">{control.reason}</p>
      <p className="text-muted-foreground">
        {zh
          ? "可直接重试停止残留进程；其他会话可以继续使用这个工作区。"
          : "Retry stopping the recorded process. Other sessions can keep using this workspace."}
      </p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        className="rounded-md bg-secondary px-3 py-1.5 disabled:opacity-40"
        onClick={() => {
          setBusy(true);
          setError(null);
          void agentRuntimeApi
            .acknowledgeRecovery(session.id)
            .then(({ session: updated }) => {
              const store = useAgentSessionStore.getState();
              store.patchSession(session.id, updated);
              void store.refreshSessions();
              void store.refreshDetail();
            })
            .catch((cause) =>
              setError(
                cause instanceof Error ? cause.message : "Recovery failed.",
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy
          ? zh
            ? "正在停止…"
            : "Stopping…"
          : zh
            ? "重试停止残留进程"
            : "Retry process cleanup"}
      </button>
    </section>
  );
}
