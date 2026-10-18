import { agentRuntimeStore } from "./session-store.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";
import { AgentRuntimeError } from "./runtime-errors.js";

export async function captureCheckpoint(
  sessionId: string,
  kind: "input" | "reply",
  messageId: string,
  stepId: string | null = null,
  omitRunId?: string,
): Promise<void> {
  await agentRuntimeStore.flushSession(sessionId);
  const head = await runtimeFacade.historyHeadAuthoritative(sessionId);
  if (!head.objectId) return;
  const id = `rust_checkpoint_${kind}_${messageId}`;
  await runtimeFacade.historyCommand({
    sessionId,
    requestId: `checkpoint:${id}`,
    operation: "checkpoint",
    payload: {
      pinId: id,
      objectId: head.objectId,
      metadata: {
        sessionId,
        kind,
        messageId,
        stepId,
        createdAt: new Date().toISOString(),
        omitRunId: omitRunId ?? null,
      },
    },
  });
}
export async function captureCompletedReply(
  sessionId: string,
  stepId?: string,
): Promise<void> {
  const message = agentRuntimeStore
    .listMessages(sessionId)
    .filter(
      (m) =>
        m.role === "assistant" &&
        !m.metadata.partial &&
        (!stepId || m.stepId === stepId),
    )
    .at(-1);
  if (!message) return;
  if (
    message.stepId &&
    !["completed", "blocked"].includes(
      agentRuntimeStore.getRunStep(message.stepId).status,
    )
  )
    return;
  await captureCheckpoint(sessionId, "reply", message.id, message.stepId);
}
export function assertHistoryUnlocked(sessionId: string): void {
  const state =
    agentRuntimeStore.getSession(sessionId).sessionMetadata?.runtimeControl;
  if (state)
    throw new AgentRuntimeError(
      "Session control operation is in progress.",
      "RECOVERY_REQUIRED",
      409,
    );
}
/** Only currently loaded, reachable tool results may authorize subsequent file writes. */
export function filterHistoryFileReads<T extends { id: string }>(
  sessionId: string,
  calls: T[],
): T[] {
  const visible = new Set(
    agentRuntimeStore.listToolCalls(sessionId).map((call) => call.id),
  );
  return calls.filter((call) => visible.has(call.id));
}
