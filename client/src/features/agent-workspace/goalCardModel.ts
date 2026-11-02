import type { AgentSession, TodoItem } from "../../adapters/transport/agentRuntime";

export type GoalStatus =
  | "planning"
  | "waiting"
  | "executing"
  | "paused"
  | "blocked"
  | "completed";

/**
 * Goal and plan metadata are persisted as raw JSON, including shapes written by
 * older runtimes. Read every field defensively instead of trusting a cast.
 */
export type GoalSnapshot = Record<string, unknown> | null;
export type GoalPlanSnapshot = {
  status?: unknown;
  revision?: unknown;
  title?: unknown;
  objective?: unknown;
  acceptanceCriteria?: unknown;
} | null;

const trimmedText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const textList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(trimmedText).filter((item): item is string => item !== null)
    : [];

const evidenceCriteria = (goal: GoalSnapshot): string[] =>
  Array.isArray(goal?.acceptanceEvidence)
    ? goal.acceptanceEvidence
        .map((item) =>
          item && typeof item === "object"
            ? trimmedText((item as { criterion?: unknown }).criterion)
            : null,
        )
        .filter((item): item is string => item !== null)
    : [];

export const planTitleOf = (plan: GoalPlanSnapshot): string | null =>
  trimmedText(plan?.title);

export const planObjectiveOf = (plan: GoalPlanSnapshot): string | null =>
  trimmedText(plan?.objective);

/** A card only owns a real goal once the model has written one, never the raw prompt. */
export const hasAuthoredGoal = (plan: GoalPlanSnapshot): boolean =>
  planTitleOf(plan) !== null;

export function statusFor(
  session: Pick<AgentSession, "status">,
  goal: GoalSnapshot,
  pendingInteraction: boolean,
  plan?: GoalPlanSnapshot,
): GoalStatus {
  const evidence = Array.isArray(goal?.acceptanceEvidence)
    ? goal.acceptanceEvidence
    : [];
  const goalStatus = typeof goal?.status === "string" ? goal.status : null;
  if (goalStatus === "completed" && evidence.length > 0) return "completed";
  if (goalStatus === "blocked" || session.status === "failed") return "blocked";
  if (
    pendingInteraction ||
    session.status === "waiting_permission" ||
    session.status === "waiting_input"
  )
    return "waiting";
  if (
    goalStatus === "executing" &&
    ["interrupted", "cancelled", "completed", "paused"].includes(session.status)
  )
    return "paused";
  // Planning is work too: a running session without an approved plan has not
  // entered execution, so the card must not claim it is executing.
  if (plan?.status !== "approved") return "planning";
  if (goalStatus === "executing" || session.status === "running")
    return "executing";
  return "planning";
}

export type GoalStageId = "goal" | "plan" | "execute" | "accept";
export type GoalStageState = "done" | "active" | "pending";

export interface GoalStage {
  id: GoalStageId;
  state: GoalStageState;
  /** Share of the overall bar owned by this stage; 0 means the run exposes no signal for it. */
  weight: number;
  /** Stage-internal completion in the 0..1 range. */
  fraction: number;
  done: number | null;
  total: number | null;
}

export interface GoalProgress {
  percent: number;
  stages: GoalStage[];
  criteria: { text: string; accepted: boolean }[];
  acceptedCount: number;
  taskDone: number;
  taskTotal: number;
}

/**
 * Staged acceptance weights. Framing and approval are real milestones, so the
 * bar keeps moving through them; execution and acceptance dominate because they
 * are what actually decide whether the goal is met. They sum to 100 so every
 * stage owns a fixed share of the bar.
 */
const STAGE_WEIGHT: Record<GoalStageId, number> = {
  goal: 10,
  plan: 10,
  execute: 35,
  accept: 45,
};

const stage = (
  id: GoalStageId,
  state: GoalStageState,
  fraction: number,
  weight: number,
  counts: { done: number; total: number } | null = null,
): GoalStage => ({
  id,
  state,
  weight,
  fraction,
  done: counts?.done ?? null,
  total: counts?.total ?? null,
});

/**
 * Progress is only credited for stages that carry a real signal: without a plan
 * there is no goal yet, without tasks there is no measurable execution, and
 * before approval nothing is executed. A stage without a signal keeps its share
 * uncredited rather than re-basing the bar, so progress never moves backwards
 * when a task list or evidence arrives mid-run.
 */
export function buildGoalProgress(input: {
  goal: GoalSnapshot;
  plan: GoalPlanSnapshot;
  todos: TodoItem[];
  completed: boolean;
}): GoalProgress {
  const authored = hasAuthoredGoal(input.plan);
  const approved = input.plan?.status === "approved";
  const accepted = new Set([
    ...textList(input.goal?.acceptedCriteria),
    ...evidenceCriteria(input.goal),
  ]);
  const criteria = textList(input.plan?.acceptanceCriteria).map((text) => ({
    text,
    accepted: accepted.has(text),
  }));
  const acceptedCount = criteria.filter((item) => item.accepted).length;
  const taskTotal = input.todos.length;
  const taskDone = input.todos.filter((todo) => todo.status === "done").length;
  const allCriteriaAccepted =
    criteria.length > 0 && acceptedCount === criteria.length;
  const allTasksDone = taskTotal > 0 && taskDone === taskTotal;

  const stages: GoalStage[] = [
    stage(
      "goal",
      authored ? "done" : "active",
      authored ? 1 : 0,
      STAGE_WEIGHT.goal,
    ),
    stage(
      "plan",
      approved ? "done" : authored ? "active" : "pending",
      approved ? 1 : 0,
      STAGE_WEIGHT.plan,
    ),
    approved
      ? stage(
          "execute",
          allTasksDone ? "done" : "active",
          taskTotal > 0 ? taskDone / taskTotal : 0,
          taskTotal > 0 ? STAGE_WEIGHT.execute : 0,
          taskTotal > 0 ? { done: taskDone, total: taskTotal } : null,
        )
      : stage("execute", "pending", 0, 0),
    stage(
      "accept",
      allCriteriaAccepted ? "done" : approved ? "active" : "pending",
      criteria.length > 0 ? acceptedCount / criteria.length : 0,
      criteria.length > 0 ? STAGE_WEIGHT.accept : 0,
      criteria.length > 0 ? { done: acceptedCount, total: criteria.length } : null,
    ),
  ];

  if (input.completed) {
    for (const item of stages) {
      item.state = "done";
      item.fraction = 1;
    }
  }

  const weighted = stages.reduce(
    (sum, item) => sum + item.weight * item.fraction,
    0,
  );
  const percent = input.completed
    ? 100
    : Math.max(0, Math.min(100, Math.round(weighted)));
  return { percent, stages, criteria, acceptedCount, taskDone, taskTotal };
}
