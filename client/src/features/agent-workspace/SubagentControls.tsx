import { useEffect, useState } from "react";
import { Archive, Square } from "lucide-react";
import type { AgentSessionStatus } from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { useNavigate } from "react-router-dom";
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
  onStopped,
  onDestroyed,
}: Props) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const [pending, setPending] = useState<"stop" | "destroy" | null>(null);
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
        await store.deleteSession(sessionId, () => navigate("/settings?section=archive"));
        setDestroyed(true);
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
          className="bui-task-open"
          disabled={pending !== null || status === "stopping"}
          aria-label={t("subSessionDestroy")}
          title={t("subSessionDestroy")}
          onClick={() => void execute("destroy")}
        >
          <Archive size={11} aria-hidden="true" />
        </button>
      </div>
      {error && (
        <span role="alert" className="max-w-64 text-[11px] text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
