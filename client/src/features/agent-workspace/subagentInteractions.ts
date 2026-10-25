import type { AgentRuntimeMessage, AgentSession } from "../../adapters/transport/agentRuntime";

export interface SubagentInteraction {
  id: string;
  kind: "assignment" | "instruction" | "progress" | "result" | "blocked";
  content: string;
  createdAt: string;
}

export function isSubagentActive(status: AgentSession["status"]): boolean {
  return ["queued", "running", "stopping", "waiting_input", "waiting_permission"].includes(status);
}

/** Public exchanges only: reasoning, tools and injected context are not reports. */
export function buildSubagentInteractions(
  session: AgentSession,
  messages: readonly AgentRuntimeMessage[],
): SubagentInteraction[] {
  const visible = [...new Map(messages.map((message) => [message.id, message])).values()]
    .filter((message) => message.sessionId === session.id
      && (message.role === "user" || message.role === "assistant")
      && message.content.trim()
      && message.metadata?.type !== "thinking"
      && message.metadata?.kind !== "thought"
      && !["context_compaction", "system_injection", "artifact_publisher", "artifact_request", "artifact_job"]
        .includes(String(message.metadata?.source)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const interactions: SubagentInteraction[] = [];
  let hasAssignment = false;
  if (!visible.some((message) => message.role === "user") && session.prompt.trim()) {
    interactions.push({ id: `${session.id}:assignment`, kind: "assignment", content: session.prompt.trim(), createdAt: session.createdAt });
    hasAssignment = true;
  }
  for (const message of visible) {
    const kind = message.role === "user" ? (hasAssignment ? "instruction" : "assignment") : "progress";
    if (message.role === "user") hasAssignment = true;
    interactions.push({ id: message.id, kind, content: message.content.trim(), createdAt: message.createdAt });
  }

  // resultSummary can belong to the previous run while a follow-up is executing.
  const result = !isSubagentActive(session.status) ? session.resultSummary?.trim() : undefined;
  if (result) {
    const last = interactions[interactions.length - 1];
    if (last?.kind === "progress" && last.content === result) last.kind = "result";
    else interactions.push({ id: `${session.id}:result`, kind: "result", content: result, createdAt: session.completedAt ?? session.updatedAt });
  }
  const reason = session.blockedReason?.trim();
  if (reason && reason !== result) {
    interactions.push({ id: `${session.id}:blocked`, kind: "blocked", content: reason, createdAt: session.updatedAt });
  }
  return interactions;
}
