import type { AgentSession } from "./contracts.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { controlRoot } from "./control-policy.js";
import { getGoalState } from "./goal-control.js";

export function rootGoal(session: AgentSession) {
  const root = controlRoot(session);
  return {
    root,
    goal:
      root.sessionMetadata?.mode === "goal"
        ? getGoalState(root.sessionMetadata)
        : null,
  };
}
export function goalStopReason(session: AgentSession): string | null {
  const { goal } = rootGoal(session);
  if (!goal) return null;
  return ["completed", "blocked", "budget_exhausted", "cancelled"].includes(
    goal.status,
  )
    ? (goal.reason ?? `Goal ${goal.status}`)
    : null;
}

export interface PlanExecutionBoundary {
  executionId?: string;
  approvedRunId?: string;
  approvedStepIndex?: number;
}
export function belongsToPlanExecution(
  call: import("./contracts.js").ToolCallRecord,
  plan: PlanExecutionBoundary | undefined,
): boolean {
  if (!plan?.executionId || !call.runId || !call.stepId) return false;
  const run = store.getRun(call.runId);
  if (run.metadata.goalExecutionId !== plan.executionId) return false;
  return (
    call.runId !== plan.approvedRunId ||
    store.getRunStep(call.stepId).index >
      (plan.approvedStepIndex ?? Number.MAX_SAFE_INTEGER)
  );
}
const NON_PROOF_TOOLS = new Set([
  "human.ask",
  "plan.propose",
  "plan.execute",
  "mode.switch",
  "goal.finish",
  "task.create",
  "task.update",
  "task.get",
  "task.list",
  "tools.invalid",
  "subagent.delegate",
  "skill.load",
  "agent.adapt",
]);
export function isGoalProof(
  call: import("./contracts.js").ToolCallRecord,
  plan: PlanExecutionBoundary | undefined,
): boolean {
  return (
    belongsToPlanExecution(call, plan) &&
    ["completed", "compacted"].includes(call.status) &&
    call.outputRef !== null &&
    !call.error &&
    !NON_PROOF_TOOLS.has(call.toolId) &&
    !(call.outputRef as { error?: unknown })?.error &&
    (!Object.hasOwn(call.outputRef as object, "exitCode") ||
      (call.outputRef as { exitCode?: number }).exitCode === 0)
  );
}
export function goalEvidenceSection(
  session: AgentSession,
  calls: import("./contracts.js").ToolCallRecord[],
): string {
  if (session.parentSessionId || session.sessionMetadata?.mode !== "goal")
    return "";
  const plan = session.sessionMetadata.plan as
    | PlanExecutionBoundary
    | undefined;
  const proof = calls.filter((c) => isGoalProof(c, plan)).slice(-20);
  return (
    "\nCurrent-plan evidence IDs (use these runtime IDs, not model-generated call IDs, in goal.finish):\n" +
    (proof
      .map((c) => `${c.id}: ${c.toolId} — ${c.outputSummary?.slice(0, 300)}`)
      .join("\n") ||
      "No eligible successful evidence yet. Verify the approved work first.")
  );
}
