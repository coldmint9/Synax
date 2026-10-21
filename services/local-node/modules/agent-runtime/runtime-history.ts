import { agentRuntimeStore } from "./session-store.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import { randomUUID } from 'node:crypto';

export async function captureCheckpoint(
  sessionId: string,
  kind: "input" | "reply",
  messageId: string,
  stepId: string | null = null,
  omitRunId?: string,
): Promise<void> {
  await agentRuntimeStore.flushSession(sessionId);
  const session=agentRuntimeStore.getSession(sessionId);
  if(session.parentSessionId)return;
  const metadata={...session.sessionMetadata};
  for(const key of ['permissionTier','permissionOverrides','runtimeControl','manualStop','inputQueue','inputForceInjectId','pendingResume','turnReferences','historyRevision','latestSystemPrompt'])delete metadata[key];
  const id = `rust_checkpoint_${kind}_${messageId}`;
  await runtimeFacade.historyCommand({
    sessionId,
    requestId: randomUUID(),
    operation: "file_checkpoint",
    payload: {
      pinId: id,
      metadata: {
        sessionId,
        kind,
        messageId,
        stepId,
        createdAt: new Date().toISOString(),
        omitRunId: omitRunId ?? null,
        historyFields: {prompt:session.prompt,contextSnapshotId:session.contextSnapshotId,sessionMetadata:metadata},
      },
    },
  });
}
/**
 * Pin a Run's reply boundary once the Run settles.
 *
 * Reply checkpoints back copy / fork / rollback on a transcript row, and the
 * transcript only offers those actions on the final reply of a round. Pinning
 * every completed step wrote one pin (with its metadata snapshot) per model
 * step even though none of the intermediate rows could act on it. Capturing only
 * the settled reply keeps the checkpoint index proportional to the number of
 * conversation rounds instead of the number of steps.
 */
export async function captureCompletedReply(sessionId: string): Promise<void> {
  const message = agentRuntimeStore
    .listMessages(sessionId)
    .filter(
      (m) =>
        m.role === "assistant" &&
        !m.metadata.partial &&
        m.metadata.type !== "thinking" &&
        m.metadata.kind !== "thought" &&
        !["artifact_publisher", "artifact_request", "artifact_job"].includes(
          String(m.metadata.source),
        ),
    )
    .at(-1);
  if (!message) return;
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
