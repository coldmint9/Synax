import { useEffect, useState } from "react";
import { Square, Trash2 } from "lucide-react";
import type { AgentSessionStatus } from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { SessionDeleteDialog } from "./SessionDeleteDialog";
import { refreshWorkspace } from "./workspaceRefresh";

interface Props {
  sessionId: string;
  parentSessionId: string | null;
  status: AgentSessionStatus;
  title: string;
  onStopped?: () => void;
  onDestroyed?: () => void;
}

export function SubagentControls({
  sessionId,
  parentSessionId,
  status,
  title,
  onStopped,
  onDestroyed,
}: Props) {
  const { t } = useLocale();
  const [pending, setPending] = useState<"stop" | "destroy" | null>(null);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [destroyed, setDestroyed] = useState(false);
  useEffect(() => setStopped(false), [sessionId, status]);
  const active =
    !stopped &&
    ["queued", "running", "waiting_permission", "waiting_input"].includes(
      status,
    );
  const execute = async (action: "stop" | "destroy") => {
    if (pending) return;
    setPending(action);
    setError(null);
    try {
      const store = useAgentSessionStore.getState();
      if (action === "stop") {
        await store.cancelSessionRun(sessionId);
        setStopped(true);
        onStopped?.();
      } else {
        await store.deleteSession(sessionId);
        setDestroyed(true);
        setConfirmDestroy(false);
        onDestroyed?.();
      }
      if (parentSessionId) {
        refreshWorkspace(parentSessionId);
        void store.fetchChildSessions(parentSessionId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };
  if (destroyed) return null;
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        {active && (
          <button
            type="button"
            className="bui-task-open"
            disabled={pending !== null}
            aria-label={t("subSessionStop")}
            onClick={() => void execute("stop")}
          >
            <Square size={11} aria-hidden="true" />
            {t("subSessionStop")}
          </button>
        )}
        <button
          type="button"
          className="bui-task-open text-danger"
          disabled={pending !== null || status === "stopping"}
          aria-label={t("subSessionDestroy")}
          title={t("subSessionDestroy")}
          onClick={() => setConfirmDestroy(true)}
        >
          <Trash2 size={11} aria-hidden="true" />
        </button>
      </div>
      {error && (
        <span role="alert" className="max-w-64 text-[11px] text-danger">
          {error}
        </span>
      )}
      <SessionDeleteDialog
        isOpen={confirmDestroy}
        sessionTitle={title}
        isDeleting={pending === "destroy"}
        onConfirm={() => void execute("destroy")}
        onClose={() => {
          if (!pending) setConfirmDestroy(false);
        }}
      />
    </div>
  );
}
