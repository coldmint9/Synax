import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, ChevronDown, CircleDot, Pause, Target, X } from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import type { AgentSession, AgentRunStep } from "../../../lib/api/agentRuntime";
import { useAgentSessionStore } from "./state/agentSessionStore";
import "./goalMonitor.css";

type GoalStatus = "planning" | "waiting" | "executing" | "blocked" | "completed";

const STATUS_LABELS: Record<GoalStatus, [string, string]> = {
  planning: ["规划中", "Planning"],
  waiting: ["等待中", "Waiting"],
  executing: ["执行中", "Executing"],
  blocked: ["已阻塞", "Blocked"],
  completed: ["已完成", "Completed"],
};

function statusFor(session: AgentSession, goal: Record<string, unknown> | null, pendingInteraction: boolean): GoalStatus {
  if (goal?.status === "completed" && Array.isArray(goal.acceptanceEvidence) && goal.acceptanceEvidence.length > 0) return "completed";
  if (goal?.status === "blocked" || session.status === "failed") return "blocked";
  if (pendingInteraction || session.status === "waiting_permission" || session.status === "waiting_input") return "waiting";
  if (goal?.status === "executing" || session.status === "running") return "executing";
  return "planning";
}

function activeStep(steps: AgentRunStep[]): AgentRunStep | undefined {
  return steps.find((step) => ["running", "waiting_permission", "waiting_input", "blocked"].includes(step.status))
    ?? [...steps].reverse().find((step) => step.status === "completed");
}

export function GoalMonitorPanel({ sessionId }: { sessionId: string }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [open, setOpen] = useState(true);
  const { session, steps, todos, interactions } = useAgentSessionStore(useShallow((state) => ({
    session: state.sessions.find((item) => item.id === sessionId),
    steps: state.selectedSessionId === sessionId ? state.steps : state.sessionDetailCache[sessionId]?.steps ?? [],
    todos: state.selectedSessionId === sessionId ? state.sessionTodos : [],
    interactions: state.interactionState?.sessionId === sessionId ? state.interactionState.items : [],
  })));

  const model = useMemo(() => {
    if (!session || session.sessionMetadata?.mode !== "goal") return null;
    const rawGoal = session.sessionMetadata.goal;
    const goal = rawGoal && typeof rawGoal === "object" && !Array.isArray(rawGoal)
      ? rawGoal as unknown as Record<string, unknown>
      : null;
    const rawPlan = session.sessionMetadata.plan;
    const plan = rawPlan && typeof rawPlan === "object" && !Array.isArray(rawPlan)
      ? rawPlan as unknown as Record<string, unknown>
      : null;
    const pendingInteraction = interactions.some((item) => item.status === "pending");
    const status = statusFor(session, goal, pendingInteraction);
    const criteria = Array.isArray(plan?.acceptanceCriteria)
      ? plan.acceptanceCriteria.filter((item): item is string => typeof item === "string")
      : [];
    const evidence = Array.isArray(goal?.acceptanceEvidence)
      ? goal.acceptanceEvidence.filter((item) => item && typeof item === "object")
      : [];
    const current = activeStep(steps);
    const completedSteps = steps.filter((step) => step.status === "completed");
    const covered = new Set(evidence.map((item) => (item as { criterion?: unknown }).criterion));
    const progress = criteria.length > 0
      ? Math.min(100, Math.round((criteria.filter((item) => covered.has(item)).length / criteria.length) * 100))
      : status === "completed" ? 100 : 0;
    return {
      goal,
      plan,
      status,
      criteria,
      evidence,
      covered,
      current,
      completedSteps,
      progress,
      title: typeof goal?.objective === "string" ? goal.objective : typeof plan?.title === "string" ? plan.title : (zh ? "当前目标" : "Current goal"),
      todos,
    };
  }, [interactions, session, steps, todos, zh]);

  if (!model) return null;
  const [zhStatus, enStatus] = STATUS_LABELS[model.status];
  const statusLabel = zh ? zhStatus : enStatus;
  const stepLabel = model.current
    ? `${zh ? "步骤" : "Step"} ${model.current.index}${model.current.status === "completed" ? ` · ${zh ? "已完成" : "Completed"}` : ` · ${zh ? "当前" : "Current"}`}`
    : zh ? "等待步骤" : "Waiting for a step";

  return (
    <aside className={`goal-monitor ${open ? "goal-monitor--open" : "goal-monitor--closed"}`} data-status={model.status} aria-label={zh ? "目标动态监控" : "Goal monitor"}>
      <button type="button" className="goal-monitor__header" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="goal-monitor__bezel" aria-hidden><Target size={15} /></span>
        <span className="goal-monitor__heading">
          <strong>{zh ? "目标监控" : "Goal monitor"}</strong>
          <small>{statusLabel}</small>
        </span>
        <span className="goal-monitor__lamp" aria-hidden />
        {open ? <ChevronDown size={15} aria-hidden /> : <CircleDot size={15} aria-hidden />}
      </button>
      {open && (
        <div className="goal-monitor__body">
          <div className="goal-monitor__objective" title={model.title}>{model.title}</div>
          <div className="goal-monitor__status-row" role="status" aria-live="polite">
            <span>{statusLabel}</span>
            <span>{model.progress}%</span>
          </div>
          <div className="goal-monitor__track" aria-label={`${zh ? "验收进度" : "Acceptance progress"}: ${model.progress}%`}>
            <span style={{ width: `${model.progress}%` }} />
          </div>
          <div className="goal-monitor__step">
            <span className="goal-monitor__step-icon" aria-hidden>
              {model.status === "completed" ? <Check size={13} /> : model.status === "waiting" ? <Pause size={12} /> : <CircleDot size={12} />}
            </span>
            <span>{stepLabel}</span>
          </div>
          <div className="goal-monitor__section">
            <span className="goal-monitor__section-title">{zh ? "已完成步骤" : "Completed steps"}</span>
            {model.completedSteps.length ? model.completedSteps.slice(-4).map((step) => (
              <div className="goal-monitor__item" key={step.id}><Check size={12} />{step.index}. {zh ? "已完成" : "Completed"}</div>
            )) : <div className="goal-monitor__muted">{zh ? "尚无已完成步骤" : "No completed steps yet"}</div>}
          </div>
          <div className="goal-monitor__section">
            <span className="goal-monitor__section-title">{zh ? "验收条件" : "Acceptance criteria"}</span>
            {model.criteria.length ? model.criteria.slice(0, 5).map((criterion, index) => (
              <div className="goal-monitor__item" key={`${criterion}-${index}`}>
                {model.covered.has(criterion) ? <Check size={12} /> : <CircleDot size={12} />}
                <span>{criterion}</span>
              </div>
            )) : <div className="goal-monitor__muted">{zh ? "等待已批准计划" : "Waiting for the approved plan"}</div>}
          </div>
          {model.todos.some((todo) => todo.status !== "done") && (
            <div className="goal-monitor__notice"><X size={12} />{zh ? "仍有未完成任务" : "Unfinished tasks remain"}</div>
          )}
        </div>
      )}
    </aside>
  );
}
