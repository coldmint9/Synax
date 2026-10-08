import { workflowMode } from "./workflow-mode.js";
import { workRuntime } from './work-runtime.js';
import * as z from "zod/v4";
import type { RegisteredTool } from "./contracts.js";
import {
  humanAskSchema,
  agentPlanSchema,
} from "./control-contracts.js";
import {
  interactionService,
  persistPlanProposal,
} from "./interaction-service.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { getGoalState, initializeGoal } from "./goal-control.js";
import { isUnrestrictedPermissionRules } from "./permission-tiers.js";
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
    "Ask up to five focused clarification questions as a durable form. This pauses execution until the user responds. For select questions, optionally include recommended option values in question.recommended; recommend at most one for single_select and any number for multi_select. Must be the only tool call in this step. Never ask for credentials. The user may skip the form instead of answering: a skip is not a refusal, it resolves as action:\"skip\" and you are expected to continue with the intent you recommended rather than asking again.",
  progressiveDetails: "Question IDs must be unique. Select questions need options with unique values. Recommendations must be unique option values and are only allowed for select questions. If both min and max are given, min must not exceed max. Child agents return questions to the primary agent.",
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
    "Submit a versioned implementation plan artifact from chat or goal. The report remains previewable across turns; the user may defer the decision and execute it from a later turn. Include explicit acceptance criteria. Must be the only tool call in this step.",
  progressiveDetails: "Step IDs must be unique and dependencies may refer only to earlier steps. humanAcceptanceCriteria must copy entries from acceptanceCriteria. Unrestricted sessions persist and execute immediately without user confirmation; other permission tiers request a user decision. Execution stays in chat unless goal was selected. Child agents return proposals to the primary agent.",
  category: "task",
  internalGate: "none",
  mutability: "task",
  resumeBehavior: "auto",
  inputSchema: agentPlanSchema,
  execute(input) {
    if (!input.runId || !input.stepId)
      throw new AgentValidationError("A plan requires an active run step.");
    const session = store.getSession(input.sessionId);
    if (isUnrestrictedPermissionRules(session.permissionRules)) {
      const planArgs = agentPlanSchema.parse(input.args);
      const artifact = persistPlanProposal(input.sessionId, planArgs);
      const plan = executeStoredPlan({
        sessionId: input.sessionId,
        runId: input.runId,
        stepId: input.stepId,
        expectedRevision: artifact.revision,
      });
      return {
        result: plan,
        displaySummary: `Started plan revision ${plan.revision}.`,
        artifacts: [{
          kind: "decision" as const,
          title: "Plan execution started",
          summary: `Started plan revision ${plan.revision}: ${plan.title}.`,
          risk: "low" as const,
        }],
      };
    }
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
  mode: z.enum(["chat", "goal"]),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict();
export const modeSwitchTool: RegisteredTool = {
  id: "mode.switch",
  label: "Switch session mode",
  description:
    "Switch this Synax session between chat and goal when the user explicitly asks for a different workflow. Planning is automatic in chat. Switching to goal does not approve or execute a saved plan. Must be the only call in a step.",
  progressiveDetails: "Child agents return workflow requests to the primary agent. Resolve pending child work before switching mode.",
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
    workRuntime.onModeChanged(session.id, workflowMode(session));
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
    "Start executing the current deferred plan. Planning returns to chat execution; only an explicitly chosen goal session remains in goal mode. Call only when the user explicitly instructs execution in the current turn instead of using the one-time execute shortcut. Must be the only call in a step.",
  progressiveDetails: "Read the saved plan before using its revision. A saved current plan and an explicit execution instruction in the current user turn are required; a stale revision is rejected. Child agents return execution requests to the primary agent.",
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
      displaySummary: `Started plan revision ${plan.revision}.`,
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
      toolCallIds: z.array(z.string()).max(40).optional().describe('Successful tool call IDs from the current work evidence inventory that support this criterion.'),
      artifactIds: z.array(z.string()).max(40).optional().describe('Runtime evidence artifact IDs from evidenceArtifacts in the current work inventory. Media asset IDs (asset_...) are not valid here.'),
    }),
  )
  .max(30);
export const goalFinishTool: RegisteredTool = {
  id: "goal.finish",
  label: "Finish goal",
  description:
    "Use as the acceptance gate for an approved goal. Submit evidence for one or more criteria; the tool records accepted criteria and returns remaining criteria until the whole goal is complete. Invalid or foreign evidence is still rejected. A concrete blocker may still be reported. Must be the only call in a step.",
  progressiveDetails: "Only available in goal mode with active work. Evidence must refer to exact approved criteria and successful tool calls or evidence artifacts from this work; asset IDs are not evidence artifact IDs. Completion still passes runtime acceptance.",
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
    const args = input.args as { status: string; reason: string; evidence?: import('./work-store.js').WorkEvidence[] };
    if (args.status === 'blocked') return workRuntime.reportBlocker(input, args.reason);
    return workRuntime.complete(input, args.reason,
      args.evidence ?? []);
  },
};

export const controlTools = [humanAskTool, planProposeTool, planExecuteTool, modeSwitchTool, goalFinishTool];
