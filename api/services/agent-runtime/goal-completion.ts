import type { ToolExecutionInput, ToolExecutionResult } from './contracts.js';
import type { AgentPlan } from './control-contracts.js';
import { checkGoalCompletion, getGoalState } from './goal-control.js';
import { agentRuntimeStore as store } from './session-store.js';
import { isGoalProof, type PlanExecutionBoundary } from './control-runtime.js';
import { interactionService } from './interaction-service.js';
import { TaskStore } from './tools/task-tools.js';
import { AgentValidationError } from './runtime-errors.js';
import type { WorkEvidence } from './work-store.js';

export function completeGoalCheckpoint(input: ToolExecutionInput): ToolExecutionResult {
    const session = store.getSession(input.sessionId),
      goal = getGoalState(session.sessionMetadata);
    if (
      !input.runId ||
      !input.stepId ||
      session.activeRunId !== input.runId ||
      session.status !== "running"
    )
      throw new AgentValidationError(
        "Goal completion requires the active run checkpoint.",
      );
    if (!goal)
      throw new AgentValidationError("This session has no active goal.");
    const args = input.args as {
      reason: string;
      evidence: WorkEvidence[];
    };
    const plan = session.sessionMetadata?.plan as
        | (AgentPlan &
            PlanExecutionBoundary & {
              revision: number;
              humanApprovedCriteria?: string[];
            })
        | undefined;
      const missing =
        plan?.humanAcceptanceCriteria
          ?.filter((c) => !plan.humanApprovedCriteria?.includes(c))
          .slice(0, 5) ?? [];
      if (missing.length) {
        if (!input.runId || !input.stepId)
          throw new AgentValidationError(
            "Human acceptance requires an active step.",
          );
        const interaction = interactionService.request({
          ...input,
          runId: input.runId,
          stepId: input.stepId,
          kind: "clarification",
          request: {
            title: "Confirm goal acceptance",
            questions: missing.map((c, index) => ({
              id: `acceptance_${index}`,
              type: "boolean",
              label: c,
              required: true,
            })),
            approvalFor: { planRevision: plan!.revision, criteria: missing },
          },
        });
        return {
          result: null,
          displaySummary: interaction.request.title,
          artifacts: [],
          suspend: { interactionId: interaction.id },
        };
      }
      const sessions = store.listSessionTree(session.id);
      const proof = sessions
        .flatMap((s) => store.listToolCalls(s.id))
        .filter((c) => isGoalProof(c, plan));
      const next = checkGoalCompletion({
        goal,
        plan:
          (session.sessionMetadata?.plan as Parameters<
            typeof checkGoalCompletion
          >[0]["plan"]) ?? null,
        evidence: args.evidence,
        subjectiveCriteria: plan?.humanAcceptanceCriteria ?? [],
        trustedUserApprovedCriteria: plan?.humanApprovedCriteria ?? [],
        pendingTaskCount: TaskStore.fromEvents(session.id)
          .list()
          .filter((t) => t.status !== "completed").length,
        activeChildCount: sessions.filter(
          (s) =>
            s.id !== session.id &&
            // Only in-flight children are unresolved; resting outcomes already
            // returned to the parent as the delegate tool result.
            ["queued", "running"].includes(s.status),
        ).length,
        pendingInteractionCount: interactionService.pending(session.id) ? 1 : 0,
        validToolCallIds: proof.map((c) => c.id),
        validArtifactIds: sessions
          .flatMap((s) => store.listArtifacts(s.id))
          .filter((a) =>
            a.sourceRefs.some(
              (r) => r.type === "tool_call" && proof.some((c) => c.id === r.id),
            ),
          )
          .map((a) => a.id),
      });
      store.updateSessionMetadata(session.id, {
        goal: { ...next, reason: args.reason },
      });
    return {
      result: { status: "completed", reason: args.reason },
      displaySummary: args.reason,
      artifacts: [],
    };
}
