import type { AgentRun, AgentSession, ToolCallRecord } from "./contracts.js";
import { isCodeNestedCall } from "./code-mode/history.js";

/** Read-only slice of the runtime store the continuation prompt needs. */
export interface SessionContinuationSource {
  listRuns(sessionId: string): AgentRun[];
  listRunToolCalls(runId: string): ToolCallRecord[];
}

/**
 * Instruction that heals a resting session instead of replaying the user's
 * original prompt. A failed or stopped Run already left its transcript, Work
 * checkpoint and tool receipts behind: the continuation points the model at
 * exactly what is left to do, so resuming never looks like a second turn.
 */
export function buildSessionContinuationPrompt(
  source: SessionContinuationSource,
  sessionId: string,
  status: AgentSession["status"],
): string {
  if (status === "failed")
    return "Session previously failed. Review the error and previous context, then retry the task from where it left off.";

  const lastRun = source
    .listRuns(sessionId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!lastRun)
    return "Session was interrupted. Continue working on the original task using tools.";

  const incompleteTools = source
    .listRunToolCalls(lastRun.id)
    .filter((call) => !isCodeNestedCall(call))
    .filter((call) => call.status === "running" || call.status === "pending");

  const parts = [
    "Session was interrupted. Reconcile the current Work checkpoint and existing results first. If the task is already done, deliver the result; otherwise perform only the remaining necessary action.",
  ];
  if (incompleteTools.length > 0) {
    const toolList = incompleteTools
      .map((call) => `- ${call.toolId}(${call.inputSummary?.slice(0, 80) ?? ""})`)
      .join("\n");
    parts.push(
      `The following tool calls were interrupted and did not complete:\n${toolList}\nRetry these operations as needed to continue the task.`,
    );
  } else {
    parts.push(
      "Review your previous tool calls and results. If the task is not fully complete, continue using tools. Only produce a final summary if ALL objectives from the original prompt have been achieved.",
    );
  }

  return parts.join("\n\n");
}
