import { agentRuntimeApi, type AgentSession, type StreamTurnRequest } from "../../../adapters/transport/agentRuntime";
import { usePendingSubmissionStore } from "./pendingSubmissionStore";

export function conversationTurnMode(session?: AgentSession | null): "turn" | "continue" {
  return session && ["interrupted", "cancelled", "failed", "completed", "paused"].includes(session.status)
    ? "continue" : "turn";
}

/** Shared optimistic submission for primary and independently observed conversations. */
export async function submitConversationMessage(
  sessionId: string,
  body: StreamTurnRequest & { message: string },
  mode: "turn" | "continue",
) {
  const requestId = crypto.randomUUID();
  const pending = usePendingSubmissionStore.getState();
  pending.begin(sessionId, {
    requestId,
    message: {
      id: `pending:${requestId}`, sessionId, runId: null, stepId: null,
      role: "user", content: body.message, contentParts: body.contentParts,
      metadata: { requestId, source: body.messageSource ?? "user", references: body.references },
      createdAt: new Date().toISOString(),
    },
  });
  try {
    const result = await agentRuntimeApi.submitRun(sessionId, body, requestId, mode);
    pending.accept(sessionId, requestId, result.run);
    return result;
  } catch (error) {
    pending.clear(sessionId, requestId);
    throw error;
  }
}
