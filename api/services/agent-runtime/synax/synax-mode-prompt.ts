import { buildGoalInstruction, getGoalState } from "../goal-control.js";
import {
  getSessionUserPrompt,
  isAgentDockSource,
} from "../session-metadata.js";
import type {
  SynaxSessionMetadata,
  SynaxSessionMode,
} from "./synax-session-mode.js";

export interface SynaxModePromptContext {
  mode: SynaxSessionMode;
  metadata: SynaxSessionMetadata;
  prompt: string;
}

export abstract class SynaxModePromptStrategy {
  abstract readonly mode: SynaxSessionMode;

  abstract buildSection(context: SynaxModePromptContext): string | null;
}

class ChatModePromptStrategy extends SynaxModePromptStrategy {
  readonly mode = "chat" as const;

  buildSection(context: SynaxModePromptContext): string | null {
    return [
      "Session mode: chat. Respond or act on the request without mandatory planning. End with concise results, actual checks, and remaining or unverified work; no structured acceptance or automatic continuation.",
      "Switch modes only on explicit user intent. Execute saved plans only through plan.execute or approval; execution stays in chat unless goal was selected.",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

class PlanModePromptStrategy extends SynaxModePromptStrategy {
  readonly mode = "plan" as const;
  buildSection(context: SynaxModePromptContext): string {
    const lines = [
      "Session mode: plan.",
      "Research only: no file edits or shell execution. Use human.ask for material unresolved decisions, then plan.propose for a versioned proposal with acceptance criteria. The one-time execute/cancel choice may be deferred.",
      "When the user explicitly asks to execute a deferred plan, call plan.execute. Execution returns to chat; it does not opt the user into goal mode. Use mode.switch only when the user explicitly asks for a different workflow mode.",
      "Control tools occupy a step alone; child work inherits the read-only constraint.",
    ];
    return lines.join("\n");
  }
}

class GoalModePromptStrategy extends SynaxModePromptStrategy {
  readonly mode = "goal" as const;

  buildSection(context: SynaxModePromptContext): string | null {
    const lines = [
      "Session mode: goal. Persist toward the authorized objective; follow the current Work checkpoint.",
      "Submit completion through goal.finish or work.checkpoint with criterion evidence. Plain final text is not goal acceptance. Control tools occupy a step alone.",
      "A completed run is not a completed goal. The round step threshold only requests a graceful wrap-up; it never forces completion or failure.",
      'When a round needs to end before acceptance, use work.checkpoint(action="yield") with a factual summary and next action. An executing approved root goal automatically continues in a new run after the previous execution releases ownership.',
      "Completion requires matching evidence for every approved acceptance criterion, referencing completed/successful tool calls or artifacts validated by the server.",
      "Never fabricate evidence or approvals. Subjective acceptance requires human.ask and explicit trusted user approval; a model-written humanApproved flag is not approval.",
      "Do not complete while there are unfinished tasks, active children, or pending interactions. Stop for input, approval, blockers, or cancellation.",
    ];
    return lines.join("\n");
  }
}

function buildStoredPlanSection(
  metadata: Record<string, unknown>,
): string | null {
  const plan = metadata.plan;
  if (!plan || typeof plan !== "object") return null;
  const value = plan as {
    revision?: unknown;
    status?: unknown;
    title?: unknown;
    objective?: unknown;
    steps?: Array<{ title?: unknown; description?: unknown }>;
    acceptanceCriteria?: unknown;
  };
  if (typeof value.title !== "string" || typeof value.objective !== "string")
    return null;
  const lines = [
    "## Saved plan",
    `Revision: ${typeof value.revision === "number" ? value.revision : "unknown"}`,
    `Status: ${typeof value.status === "string" ? value.status : "unknown"}`,
    `Title: ${value.title}`,
    `Objective: ${value.objective}`,
  ];
  const steps = Array.isArray(value.steps) ? value.steps : [];
  if (steps.length) {
    lines.push(
      `Steps (${Math.min(steps.length, 12)} of ${steps.length}):`,
      ...steps
        .slice(0, 12)
        .map(
          (step, index) =>
            `- ${index + 1}. ${typeof step.title === "string" ? step.title : "Untitled step"}${typeof step.description === "string" ? `: ${step.description.slice(0, 500)}` : ""}`,
        ),
    );
  }
  const criteria = Array.isArray(value.acceptanceCriteria)
    ? value.acceptanceCriteria.filter(
        (criterion): criterion is string => typeof criterion === "string",
      )
    : [];
  if (criteria.length) {
    lines.push(
      `Acceptance criteria (${Math.min(criteria.length, 12)} of ${criteria.length}):`,
      ...criteria
        .slice(0, 12)
        .map((criterion) => `- ${criterion.slice(0, 500)}`),
    );
  }
  lines.push(
    value.status === "approved"
      ? "This revision is approved. Mode changes do not discard its acceptance requirements."
      : "Saved, not executing. Execution requires plan.execute after explicit user intent or the plan approval interaction.",
  );
  return lines.join("\n");
}

class PlanNodeModePromptStrategy extends SynaxModePromptStrategy {
  readonly mode = "plan_node" as const;

  buildSection(context: SynaxModePromptContext): string | null {
    const lines = [
      "Session mode: plan_node.",
      "Execute one bounded plan node. Prefer minimal, focused diffs.",
      "Explain blockers clearly if you cannot finish.",
    ];
    return lines.join("\n");
  }
}

export class SynaxModePromptRegistry {
  private readonly strategies = new Map<
    SynaxSessionMode,
    SynaxModePromptStrategy
  >();

  constructor() {
    for (const strategy of [
      new ChatModePromptStrategy(),
      new PlanModePromptStrategy(),
      new GoalModePromptStrategy(),
      new PlanNodeModePromptStrategy(),
    ]) {
      this.strategies.set(strategy.mode, strategy);
    }
  }

  resolve(mode: SynaxSessionMode): SynaxModePromptStrategy {
    return this.strategies.get(mode) ?? new ChatModePromptStrategy();
  }

  buildSection(context: SynaxModePromptContext): string | null {
    return this.resolve(context.mode).buildSection(context);
  }
}

export const synaxModePromptRegistry = new SynaxModePromptRegistry();

/** Mutable session data belongs in the final runtime reminder, not mode instructions. */
export function buildSynaxRuntimeState(
  context: SynaxModePromptContext,
): string {
  const lines = [
    buildStoredPlanSection(context.metadata as Record<string, unknown>),
  ];
  if (context.mode === "goal") {
    const state = getGoalState(context.metadata as Record<string, unknown>);
    const userPrompt = getSessionUserPrompt(context.metadata) ?? context.prompt;
    if (state)
      lines.push(
        buildGoalInstruction(
          state,
          (context.metadata as Record<string, unknown>).plan as Parameters<
            typeof buildGoalInstruction
          >[1],
        ),
      );
    else if (userPrompt) lines.push(`Objective: ${userPrompt}`);
    if (
      isAgentDockSource(context.metadata.source) &&
      context.metadata.documentId
    )
      lines.push(
        `Related Wiki document: ${context.metadata.documentId}. Keep affected documentation aligned with the authorized change.`,
      );
  }
  if (context.mode === "plan_node") {
    if (context.metadata.planNodeTitle)
      lines.push(`Plan node: ${context.metadata.planNodeTitle}`);
    if (context.prompt.trim())
      lines.push("## Node Task", context.prompt.trim());
  }
  return lines.filter(Boolean).join("\n");
}
