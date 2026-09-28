import type { AgentSession, ToolCallRecord } from "./contracts.js";
import { controlRoot } from "./control-policy.js";
import { usesGoalWorkflow } from "./workflow-mode.js";
import { getGoalState } from "./goal-control.js";
import {
  belongsToPlanExecution,
  isGoalProof,
  planBoundaryOf,
  supersededReceipts,
  treeWorks,
} from "./evidence-inventory.js";

// Evidence authority lives in evidence-inventory.ts. The goal layer, the work
// layer and the prompt inventories all use that single predicate, so the
// runtime can never advertise an id it later rejects.
export { belongsToPlanExecution, isGoalProof };
export type { PlanExecutionBoundary } from "./evidence-inventory.js";

export function rootGoal(session: AgentSession) {
  const root = controlRoot(session);
  return {
    root,
    goal:
      usesGoalWorkflow(root) && Boolean(root.sessionMetadata?.goal)
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

export function goalEvidenceSection(
  session: AgentSession,
  calls: ToolCallRecord[],
): string {
  if (session.parentSessionId || session.sessionMetadata?.mode !== "goal")
    return "";
  const plan = planBoundaryOf(session);
  // A receipt that a later change version replaced is exactly what completion
  // rejects, so it must never be advertised here as usable evidence.
  const superseded = new Set(supersededReceipts(treeWorks(session.id)).keys());
  const proof = calls.filter((c) => isGoalProof(c, plan) && !superseded.has(c.id));
  const withheld = calls.filter(
    (c) => isGoalProof(c, plan) && superseded.has(c.id),
  ).length;
  return (
    "\nCurrent-plan evidence IDs (use these runtime IDs, not model-generated call IDs, in goal.finish):\n" +
    (proof
      .slice(-20)
      .map((c) => `${c.id}: ${c.toolId} — ${c.outputSummary?.slice(0, 300)}`)
      .join("\n") ||
      "No eligible successful evidence yet. Verify the approved work first.") +
    (withheld
      ? `\n${withheld} superseded verification receipt(s) withheld: a receipt that no longer attests the current change version is rejected by goal.finish. Rerun verification.run for the changed scope instead of citing it.`
      : "")
  );
}
