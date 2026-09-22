import { createHash } from "node:crypto";
import type { StructuredToolCall } from "./contracts.js";
import { agentRuntimeStore } from "./session-store.js";

export interface TurnReference {
  kind: "skill" | "mcp" | "file" | "wiki";
  id: string;
  label?: string;
}

/** Picker metadata is not part of the submitted turn reference. */
export interface TurnReferenceOption extends TurnReference {
  recent?: boolean;
}

export interface TurnReferenceContext {
  references: TurnReference[];
  content: string;
  skillIds: string[];
  mcpServerIds: string[];
}

/** References belong to the active user turn, never to the session's permanent tool configuration. */
export function activeTurnReferences(
  sessionId: string,
): TurnReferenceContext | undefined {
  const session = agentRuntimeStore.getSession(sessionId);
  if (!session.activeRunId) return undefined;
  return agentRuntimeStore.getRun(session.activeRunId).metadata
    .turnReferences as TurnReferenceContext | undefined;
}

export function effectiveTurnMcpIds(sessionId: string): string[] {
  const selected = activeTurnReferences(sessionId)?.mcpServerIds;
  return selected?.length
    ? selected
    : (agentRuntimeStore.getSession(sessionId).mcpServerIds ?? []);
}

/** Each selected skill loads once per user input, including forced queue inputs
 * within a Run. Persisted call IDs make permission resume/replay idempotent. */
export function pendingTurnReferenceSkillLoads(
  sessionId: string,
): StructuredToolCall[] {
  const selected = activeTurnReferences(sessionId);
  if (!selected?.skillIds.length) return [];
  const session = agentRuntimeStore.getSession(sessionId);
  const run = agentRuntimeStore.getRun(session.activeRunId!);
  const inputId =
    run.metadata.turnReferenceInputId ?? run.triggerMessageId ?? run.id;
  const called = new Set(
    agentRuntimeStore
      .listRunToolCalls(run.id)
      .map((call) => call.modelToolCallId),
  );
  return [...new Set(selected.skillIds)]
    .map((skillId) => ({
      id: `turn_skill_${createHash("sha256")
        .update(JSON.stringify([run.id, inputId, skillId]))
        .digest("hex")
        .slice(0, 24)}`,
      toolId: "skill.load",
      args: { skillId },
      reason: "Load the user-selected skill for this turn.",
    }))
    .filter((call) => !called.has(call.id));
}
