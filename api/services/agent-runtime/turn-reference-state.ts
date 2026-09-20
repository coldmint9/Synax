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
