import type { AgentRunStep, AgentRuntimeMessage } from "./contracts.js";
import { readRuntimeReminder } from "./runtime-request-snapshot.js";

export interface ContextInputOwner {
  stepId: string;
  placement: "before" | "after";
}
/** One ownership rule for history replay and memory extraction, including legacy queues. */
export function resolveContextInputOwners(
  steps: AgentRunStep[],
  inputs: AgentRuntimeMessage[],
): Map<string, ContextInputOwner> {
  const explicit = new Map<string, number>();
  for (const message of inputs) {
    const index = message.metadata?.consumedBeforeStepIndex;
    if (typeof index === "number" && Number.isSafeInteger(index) && index > 0)
      explicit.set(message.id, index);
  }
  for (const step of steps)
    for (const id of readRuntimeReminder(step.metadata)?.queuedInputIds ?? [])
      if (!explicit.has(id)) explicit.set(id, step.index);
  const owners = new Map<string, ContextInputOwner>();
  for (const input of inputs) {
    const known = explicit.get(input.id);
    const before =
      known !== undefined
        ? steps.find((step) => step.index >= known)
        : steps.find(
            (step) =>
              !readRuntimeReminder(step.metadata) &&
              input.createdAt <= step.startedAt,
          );
    if (before)
      owners.set(input.id, { stepId: before.id, placement: "before" });
    else if (steps.length)
      owners.set(input.id, { stepId: steps.at(-1)!.id, placement: "after" });
  }
  return owners;
}
