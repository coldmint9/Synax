import { isGoalProof, type PlanExecutionBoundary } from "./control-runtime.js";
import * as z from "zod/v4";
import type { RegisteredTool } from "./contracts.js";
import {
  humanAskSchema,
  agentPlanSchema,
  type AgentPlan,
} from "./control-contracts.js";
import { interactionService } from "./interaction-service.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { checkGoalCompletion, getGoalState } from "./goal-control.js";
import { TaskStore } from "./tools/task-tools.js";
import { AgentValidationError } from "./runtime-errors.js";

export const humanAskTool: RegisteredTool = {
  id: "human.ask",
  label: "Ask the user",
  description:
    "Ask up to five focused clarification questions as a durable form. This pauses execution until the user responds. Must be the only tool call in this step. Never ask for credentials.",
  category: "task",
  internalGate: "none",
  mutability: "task",
  resumeBehavior: "auto",
  inputSchema: humanAskSchema,
  execute(input) {
    if (!input.runId || !input.stepId)
      throw new AgentValidationError(
        "Human input requires an active run step.",
      );
    const interaction = interactionService.request({
      ...input,
      runId: input.runId,
      stepId: input.stepId,
      kind: "clarification",
      request: input.args,
    });
    return {
      result: null,
      displaySummary: interaction.request.title,
      artifacts: [],
      suspend: { interactionId: interaction.id },
    };
  },
};
export const planProposeTool: RegisteredTool = {
  id: "plan.propose",
  label: "Propose a plan",
  description:
    "Submit a versioned implementation plan for human review. User can save, request changes or approve execution. Include explicit acceptance criteria. Must be the only tool call in this step.",
  category: "task",
  internalGate: "none",
  mutability: "task",
  resumeBehavior: "auto",
  inputSchema: agentPlanSchema,
  execute(input) {
    if (!input.runId || !input.stepId)
      throw new AgentValidationError("A plan requires an active run step.");
    const interaction = interactionService.request({
      ...input,
      runId: input.runId,
      stepId: input.stepId,
      kind: "plan_approval",
      request: { plan: input.args },
    });
    return {
      result: null,
      displaySummary: interaction.request.title,
      artifacts: [],
      suspend: { interactionId: interaction.id },
    };
  },
};
const evidenceSchema = z
  .array(
    z.object({
      criterion: z.string().min(1).max(4000),
      summary: z.string().min(1).max(4000),
      toolCallIds: z.array(z.string()).max(40).optional(),
      artifactIds: z.array(z.string()).max(40).optional(),
    }),
  )
  .max(30);
export const goalFinishTool: RegisteredTool = {
  id: "goal.finish",
  label: "Finish goal",
  description:
    "Finish an approved goal with proof for every acceptance criterion, or report a concrete blocker. Completed tasks alone are not proof. Must be the only call in a step.",
  category: "task",
  internalGate: "none",
  mutability: "task",
  resumeBehavior: "auto",
  inputSchema: z.object({
    status: z.enum(["completed", "blocked"]),
    reason: z.string().min(1).max(4000),
    evidence: evidenceSchema.default([]),
  }),
  execute(input) {
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
      status: "completed" | "blocked";
      reason: string;
      evidence: z.infer<typeof evidenceSchema>;
    };
    if (args.status === "blocked") {
      store.updateSessionMetadata(session.id, {
        goal: { ...goal, status: "blocked", reason: args.reason },
      });
    } else {
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
            [
              "queued",
              "running",
              "waiting_permission",
              "waiting_input",
              "interrupted",
              "paused",
            ].includes(s.status),
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
    }
    return {
      result: { status: args.status, reason: args.reason },
      displaySummary: args.reason,
      artifacts: [],
    };
  },
};

export const controlTools = [humanAskTool, planProposeTool, goalFinishTool];
