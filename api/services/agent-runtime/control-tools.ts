import { workRuntime } from './work-runtime.js';
import * as z from "zod/v4";
import type { RegisteredTool } from "./contracts.js";
import {
  humanAskSchema,
  agentPlanSchema,
} from "./control-contracts.js";
import { interactionService } from "./interaction-service.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { getGoalState, initializeGoal } from "./goal-control.js";
import {
  assertUserInstructionTurn,
  executeStoredPlan,
  getStoredPlan,
  getUserInstructionText,
} from "./plan-execution.js";
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
    "Submit a versioned implementation plan for a one-time execute-or-cancel confirmation. The user may also defer the decision and execute it from a later turn. Include explicit acceptance criteria. Must be the only tool call in this step.",
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
const modeSwitchSchema = z.object({
  mode: z.enum(["chat", "plan", "goal"]),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict();
export const modeSwitchTool: RegisteredTool = {
  id: "mode.switch",
  label: "Switch session mode",
  description:
    "Switch this Synax session between chat, plan, and goal when the user explicitly asks for a different workflow. Switching to goal does not approve or execute a saved plan. Must be the only call in a step.",
  category: "task",
  internalGate: "none",
  mutability: "task",
  resumeBehavior: "auto",
  inputSchema: modeSwitchSchema,
  execute(input) {
    if (!input.runId || !input.stepId)
      throw new AgentValidationError("A mode switch requires an active run step.");
    const args = modeSwitchSchema.parse(input.args);
    const session = store.getSession(input.sessionId);
    assertUserInstructionTurn({
      sessionId: session.id,
      runId: input.runId,
      action: "Mode switching",
    });
    let goal = getGoalState(session.sessionMetadata);
    if (args.mode === "goal") {
      const plan = getStoredPlan(session.id);
      if (!goal || ["completed", "cancelled", "blocked", "budget_exhausted"].includes(goal.status)) {
        const instruction = getUserInstructionText(session.id, input.runId)?.trim();
        goal = initializeGoal(plan?.objective || instruction || session.prompt);
      }
    }
    store.updateSessionMetadata(session.id, {
      mode: args.mode,
      ...(goal ? { goal } : {}),
    });
    return {
      result: { mode: args.mode, reason: args.reason ?? null, goalStatus: goal?.status ?? null },
      displaySummary: `Switched session mode to ${args.mode}.`,
      artifacts: [],
    };
  },
};
const planExecuteSchema = z.object({
  revision: z.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict();
export const planExecuteTool: RegisteredTool = {
  id: "plan.execute",
  label: "Execute saved plan",
  description:
    "Start executing the current deferred plan in goal mode. Call only when the user explicitly instructs execution in the current turn instead of using the one-time execute shortcut. Must be the only call in a step.",
  category: "task",
  internalGate: "none",
  mutability: "task",
  resumeBehavior: "auto",
  inputSchema: planExecuteSchema,
  execute(input) {
    if (!input.runId || !input.stepId)
      throw new AgentValidationError("Plan execution requires an active run step.");
    const args = planExecuteSchema.parse(input.args ?? {});
    assertUserInstructionTurn({
      sessionId: input.sessionId,
      runId: input.runId,
      action: "Plan execution",
    });
    const plan = executeStoredPlan({
      sessionId: input.sessionId,
      runId: input.runId,
      stepId: input.stepId,
      expectedRevision: args.revision,
    });
    return {
      result: plan,
      displaySummary: `Started plan revision ${plan.revision} in goal mode.`,
      artifacts: [{
        kind: "decision",
        title: "Plan execution started",
        summary: `Started plan revision ${plan.revision}: ${plan.title}.`,
        risk: "low",
      }],
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
    return workRuntime.complete(input, (input.args as { reason: string }).reason,
      (input.args as { evidence: import('./work-store.js').WorkEvidence[] }).evidence,
      (input.args as { status: string }).status === 'blocked');
  },
};

export const controlTools = [humanAskTool, planProposeTool, planExecuteTool, modeSwitchTool, goalFinishTool];
