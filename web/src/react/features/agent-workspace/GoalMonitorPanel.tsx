import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, CircleDot, Pause, Play, Target, X } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import type { AgentSession } from "../../../lib/api/agentRuntime";
import { useAgentSessionStore } from "./state/agentSessionStore";
import "./goalMonitor.css";

type GoalStatus =
  | "planning"
  | "waiting"
  | "executing"
  | "paused"
  | "blocked"
  | "completed";

const STATUS_LABELS: Record<GoalStatus, [string, string]> = {
  planning: ["规划中", "Planning"],
  waiting: ["等待中", "Waiting"],
  executing: ["执行中", "Executing"],
  paused: ["已暂停", "Paused"],
  blocked: ["已阻塞", "Blocked"],
  completed: ["已完成", "Completed"],
};

export function statusFor(
  session: Pick<AgentSession, "status">,
  goal: Record<string, unknown> | null,
  pendingInteraction: boolean,
): GoalStatus {
  if (
    goal?.status === "completed" &&
    Array.isArray(goal.acceptanceEvidence) &&
    goal.acceptanceEvidence.length > 0
  )
    return "completed";
  if (goal?.status === "blocked" || session.status === "failed")
    return "blocked";
  if (
    pendingInteraction ||
    session.status === "waiting_permission" ||
    session.status === "waiting_input"
  )
    return "waiting";
  if (
    goal?.status === "executing" &&
    ["interrupted", "cancelled", "completed"].includes(session.status)
  )
    return "paused";
  if (goal?.status === "executing" || session.status === "running")
    return "executing";
  return "planning";
}

export function GoalMonitorPanel({ sessionId }: { sessionId: string }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const { session, todos, interactions } = useAgentSessionStore(
    useShallow((state) => ({
      session: state.sessions.find((item) => item.id === sessionId),
      todos: state.selectedSessionId === sessionId ? state.sessionTodos : [],
      interactions:
        state.interactionState?.sessionId === sessionId
          ? state.interactionState.items
          : [],
    })),
  );
  const cancelSessionRun = useAgentSessionStore(
    (state) => state.cancelSessionRun,
  );
  const resumeSession = useAgentSessionStore((state) => state.resumeSession);
  const [controlBusy, setControlBusy] = useState(false);

  const model = useMemo(() => {
    if (!session || session.sessionMetadata?.mode !== "goal") return null;
    const rawGoal = session.sessionMetadata.goal;
    const goal =
      rawGoal && typeof rawGoal === "object" && !Array.isArray(rawGoal)
        ? (rawGoal as unknown as Record<string, unknown>)
        : null;
    const rawPlan = session.sessionMetadata.plan;
    const plan =
      rawPlan && typeof rawPlan === "object" && !Array.isArray(rawPlan)
        ? (rawPlan as unknown as Record<string, unknown>)
        : null;
    const pendingInteraction = interactions.some(
      (item) => item.status === "pending",
    );
    const status = statusFor(session, goal, pendingInteraction);
    const criteria = Array.isArray(plan?.acceptanceCriteria)
      ? plan.acceptanceCriteria.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    const evidence = Array.isArray(goal?.acceptanceEvidence)
      ? goal.acceptanceEvidence.filter(
          (item) => item && typeof item === "object",
        )
      : [];
    const covered = new Set(
      evidence.map((item) => (item as { criterion?: unknown }).criterion),
    );
    const progress =
      criteria.length > 0
        ? Math.min(
            100,
            Math.round(
              (criteria.filter((item) => covered.has(item)).length /
                criteria.length) *
                100,
            ),
          )
        : status === "completed"
          ? 100
          : 0;
    return {
      goal,
      plan,
      status,
      criteria,
      evidence,
      covered,
      progress,
      title:
        typeof goal?.objective === "string"
          ? goal.objective
          : typeof plan?.title === "string"
            ? plan.title
            : zh
              ? "当前目标"
              : "Current goal",
      todos,
    };
  }, [interactions, session, todos, zh]);

  if (!model) return null;
  const [zhStatus, enStatus] = STATUS_LABELS[model.status];
  const statusLabel = zh ? zhStatus : enStatus;
  const canPause = model.status === "executing";
  const canResume = model.status === "paused";
  const handleControl = async () => {
    if (controlBusy || (!canPause && !canResume)) return;
    setControlBusy(true);
    try {
      if (canPause) await cancelSessionRun(sessionId);
      else await resumeSession(sessionId);
    } finally {
      setControlBusy(false);
    }
  };
  return (
    <aside
      className="goal-monitor"
      data-status={model.status}
      aria-label={zh ? "目标" : "Goal"}
    >
      <div className="goal-monitor__header">
        <span className="goal-monitor__bezel" aria-hidden>
          <Target size={15} />
        </span>
        <span className="goal-monitor__heading">
          <strong>{zh ? "目标" : "Goal"}</strong>
        </span>
        <span className="goal-monitor__lamp" aria-hidden />
      </div>
      <div className="goal-monitor__body">
        <div className="goal-monitor__objective" title={model.title}>
          {model.title}
        </div>
        {(canPause || canResume) && (
          <button
            type="button"
            className="goal-monitor__control"
            onClick={() => void handleControl()}
            disabled={controlBusy}
            aria-label={
              canPause
                ? zh
                  ? "暂停目标"
                  : "Pause goal"
                : zh
                  ? "继续目标"
                  : "Resume goal"
            }
          >
            {canPause ? (
              <Pause size={13} aria-hidden />
            ) : (
              <Play size={13} aria-hidden />
            )}
            <span>
              {canPause ? (zh ? "暂停" : "Pause") : zh ? "继续" : "Resume"}
            </span>
          </button>
        )}
        <div
          className="goal-monitor__status-row"
          role="status"
          aria-live="polite"
        >
          <span>{statusLabel}</span>
          <span>{model.progress}%</span>
        </div>
        <div
          className="goal-monitor__track"
          aria-label={`${zh ? "验收进度" : "Acceptance progress"}: ${model.progress}%`}
        >
          <span style={{ width: `${model.progress}%` }} />
        </div>
        <div className="goal-monitor__section goal-monitor__section--criteria">
          <span className="goal-monitor__section-title">
            {zh ? "验收进度" : "Acceptance progress"}
          </span>
          {model.criteria.length ? (
            model.criteria.map((criterion, index) => (
              <div className="goal-monitor__item" key={`${criterion}-${index}`}>
                {model.covered.has(criterion) ? (
                  <Check size={12} />
                ) : (
                  <CircleDot size={12} />
                )}
                <span>{criterion}</span>
              </div>
            ))
          ) : (
            <div className="goal-monitor__muted">
              {zh ? "等待已批准计划" : "Waiting for the approved plan"}
            </div>
          )}
        </div>
        {model.todos.some((todo) => todo.status !== "done") && (
          <div className="goal-monitor__notice">
            <X size={12} />
            {zh ? "仍有未完成任务" : "Unfinished tasks remain"}
          </div>
        )}
      </div>
    </aside>
  );
}
