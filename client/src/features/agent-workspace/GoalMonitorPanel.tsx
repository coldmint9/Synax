import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Check,
  Circle,
  CircleDot,
  Goal,
  Pause,
  Play,
  TriangleAlert,
} from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import type {
  AgentInteraction,
  TodoItem,
} from "../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "./state/agentSessionStore";
import {
  buildGoalProgress,
  hasAuthoredGoal,
  planObjectiveOf,
  planTitleOf,
  statusFor,
  type GoalPlanSnapshot,
  type GoalSnapshot,
  type GoalStageId,
  type GoalStageState,
  type GoalStatus,
} from "./goalCardModel";
import "./goalMonitor.css";

/** Stable empties keep the store selector referentially safe between renders. */
const NO_INTERACTIONS: AgentInteraction[] = [];
const NO_TODOS: TodoItem[] = [];

const STATUS_LABELS: Record<Exclude<GoalStatus, "planning">, [string, string]> = {
  waiting: ["等待中", "Waiting"],
  executing: ["执行中", "Executing"],
  paused: ["已暂停", "Paused"],
  blocked: ["已阻塞", "Blocked"],
  completed: ["已完成", "Completed"],
};

const FRAMING_LABELS: Record<"drafting" | "approval", [string, string]> = {
  drafting: ["梳理目标", "Framing"],
  approval: ["待批准", "Awaiting approval"],
};

const STAGE_LABELS: Record<GoalStageId, [string, string]> = {
  goal: ["目标", "Goal"],
  plan: ["计划", "Plan"],
  execute: ["执行", "Execute"],
  accept: ["验收", "Acceptance"],
};

const STAGE_STATE_LABELS: Record<GoalStageState, [string, string]> = {
  done: ["已完成", "done"],
  active: ["进行中", "in progress"],
  pending: ["未开始", "not started"],
};

/** Only a model-authored plan names the goal; the raw prompt is never a goal. */
export function statusLabelFor(
  status: GoalStatus,
  authored: boolean,
  zh: boolean,
): string {
  if (status === "planning") {
    const [zhLabel, enLabel] = FRAMING_LABELS[authored ? "approval" : "drafting"];
    return zh ? zhLabel : enLabel;
  }
  const [zhLabel, enLabel] = STATUS_LABELS[status];
  return zh ? zhLabel : enLabel;
}

function StageIcon({ state }: { state: GoalStageState }) {
  if (state === "done") return <Check size={12} aria-hidden />;
  if (state === "active") return <CircleDot size={12} aria-hidden />;
  return <Circle size={12} aria-hidden />;
}

export function GoalMonitorPanel({ sessionId }: { sessionId: string }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const { session, todos, interactions } = useAgentSessionStore(
    useShallow((state) => ({
      session: state.sessions.find((item) => item.id === sessionId),
      todos:
        state.selectedSessionId === sessionId ? state.sessionTodos : NO_TODOS,
      interactions:
        state.interactionState?.sessionId === sessionId
          ? state.interactionState.items
          : NO_INTERACTIONS,
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
    const goal: GoalSnapshot =
      rawGoal && typeof rawGoal === "object" && !Array.isArray(rawGoal)
        ? (rawGoal as unknown as Record<string, unknown>)
        : null;
    const rawPlan = session.sessionMetadata.plan;
    const plan: GoalPlanSnapshot =
      rawPlan && typeof rawPlan === "object" && !Array.isArray(rawPlan)
        ? (rawPlan as GoalPlanSnapshot)
        : null;
    const pendingInteraction = interactions.some(
      (item) => item.status === "pending",
    );
    const status = statusFor(session, goal, pendingInteraction, plan);
    const authored = hasAuthoredGoal(plan);
    const progress = buildGoalProgress({
      goal,
      plan,
      todos,
      completed: status === "completed",
    });
    const reason =
      typeof goal?.reason === "string" && goal.reason.trim()
        ? goal.reason.trim()
        : "";
    return {
      status,
      authored,
      progress,
      title: planTitleOf(plan),
      objective: planObjectiveOf(plan),
      reason,
      unfinishedTasks:
        progress.taskTotal > 0 && progress.taskDone < progress.taskTotal,
      acceptedAll:
        progress.criteria.length > 0 &&
        progress.acceptedCount === progress.criteria.length,
    };
  }, [interactions, session, todos]);

  if (!model) return null;
  const { status, authored, progress } = model;
  const statusLabel = statusLabelFor(status, authored, zh);
  const canPause = status === "executing";
  const canResume = status === "paused";
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
  const blockedNotice =
    status === "blocked" && authored ? model.reason : null;
  const stalledNotice =
    !blockedNotice && model.acceptedAll && model.unfinishedTasks
      ? zh
        ? "仍有未完成任务"
        : "Unfinished tasks remain"
      : null;
  // A completed goal that kept no plan is not loading anything: stay quiet
  // instead of showing a skeleton forever.
  const showSkeleton =
    !authored && !model.reason && status !== "completed";
  return (
    <aside
      className="goal-monitor"
      data-status={status}
      aria-label={zh ? "目标" : "Goal"}
    >
      <div className="goal-monitor__header">
        <span className="goal-monitor__bezel" aria-hidden>
          <Goal size={15} />
        </span>
        <span className="goal-monitor__heading">
          <strong>{zh ? "目标" : "Goal"}</strong>
        </span>
        <span className="goal-monitor__lamp" aria-hidden />
      </div>
      <div className="goal-monitor__body">
        {authored ? (
          <div className="goal-monitor__goal">
            <strong title={model.title ?? undefined}>{model.title}</strong>
            {model.objective && model.objective !== model.title ? (
              <p className="goal-monitor__objective" title={model.objective}>
                {model.objective}
              </p>
            ) : null}
          </div>
        ) : model.reason ? (
          <p
            className="goal-monitor__objective goal-monitor__objective--reason"
            title={model.reason}
          >
            {model.reason}
          </p>
        ) : showSkeleton ? (
          <div className="goal-monitor__skeleton" aria-hidden>
            <span />
            <span />
            <span />
          </div>
        ) : null}
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
          {authored ? (
            <span className="goal-monitor__percent">{progress.percent}%</span>
          ) : null}
        </div>
        {authored ? (
          <>
            <div
              className="goal-monitor__track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
              aria-label={`${zh ? "目标进度" : "Goal progress"}: ${progress.percent}%`}
            >
              <span style={{ width: `${progress.percent}%` }} />
            </div>
            <ol className="goal-monitor__stages" aria-label={zh ? "阶段" : "Stages"}>
              {progress.stages.map((item) => {
                const [zhStage, enStage] = STAGE_LABELS[item.id];
                const stageLabel = zh ? zhStage : enStage;
                const counts =
                  item.total !== null ? `${item.done ?? 0}/${item.total}` : null;
                const [zhState, enState] = STAGE_STATE_LABELS[item.state];
                return (
                  <li
                    className="goal-monitor__stage"
                    data-state={item.state}
                    key={item.id}
                    aria-label={`${stageLabel} ${zh ? zhState : enState}${counts ? ` ${counts}` : ""}`}
                  >
                    <StageIcon state={item.state} />
                    <span className="goal-monitor__stage-label">
                      {stageLabel}
                    </span>
                    {counts ? (
                      <span className="goal-monitor__stage-count">
                        {counts}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            <div className="goal-monitor__section goal-monitor__section--criteria">
              <span className="goal-monitor__section-title">
                {zh ? "验收标准" : "Acceptance criteria"}
              </span>
              {progress.criteria.length ? (
                progress.criteria.map((item) => (
                  <div
                    className="goal-monitor__item"
                    data-accepted={item.accepted ? "true" : "false"}
                    key={item.text}
                  >
                    {item.accepted ? (
                      <Check size={12} aria-hidden />
                    ) : (
                      <Circle size={12} aria-hidden />
                    )}
                    <span>{item.text}</span>
                  </div>
                ))
              ) : null}
            </div>
          </>
        ) : null}
        {blockedNotice || stalledNotice ? (
          <div className="goal-monitor__notice">
            <TriangleAlert size={12} />
            {blockedNotice ?? stalledNotice}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
