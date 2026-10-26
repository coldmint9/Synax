import { randomUUID } from "node:crypto";
import type { AgentRun, AgentRuntimeMessage } from "./contracts.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { decode, persistEntity, runtimeClient } from "./sidecar/runtime-repository.js";
import { hydrateHistoryValues } from "./sidecar/history-pages.js";
import { RuntimeSidecarError } from "./sidecar/sidecar-client.js";
import { snapshotVisualization } from "./visualization-integration.js";
import { visualizationBlocks } from "./visualization-protocol.js";

/** Resolve exact identities from Rust, even when the API process has no working
 * set for this session. Never scan the conversation to open one preview. */
async function readRecord<T>(sessionId: string, kind: string, id: string): Promise<T | undefined> {
  const client = runtimeClient();
  const page = decode<{ items: Array<{ value: T }> }>(await client.historyCommand({
    sessionId, requestId: randomUUID(), operation: "execution_refs",
    payload: { refs: [{ kind, id }] },
  }));
  return (await hydrateHistoryValues(client, sessionId, page.items.map(item => item.value)))[0];
}

/** undefined means the message is absent; null means it has no eligible preview. */
export async function loadHistoricalVisualization(
  sessionId: string,
  messageId: string,
): Promise<AgentRuntimeMessage | null | undefined> {
  await store.flushSession(sessionId);
  const message = await readRecord<AgentRuntimeMessage>(sessionId, "message", messageId);
  if (!message || message.sessionId !== sessionId) return undefined;
  if (message.role !== "assistant" || message.metadata.partial ||
      message.metadata.type === "thinking" || message.metadata.kind === "thought") return null;
  if (message.metadata.source === "inline_visualization" ||
      (message.metadata.purpose === "work_result" && Array.isArray(message.metadata.visualizations))) return message;
  if (!message.runId || !visualizationBlocks(message.content).length) return null;
  const run = await readRecord<AgentRun>(sessionId, "run", message.runId);
  if (run?.sessionId !== sessionId || run.status !== "completed") return null;
  await store.hydrateSessionSummary(sessionId);
  const preview = snapshotVisualization(sessionId, message.content, message.id);
  if (!preview) return null;
  const restored = { ...message, metadata: { ...message.metadata,
    source: "inline_visualization", visualizationOrigin: message.metadata.source, visualization: preview,
  } };
  try {
    await persistEntity(sessionId, "runtime.message", restored);
    store.acceptMessageProjection(restored);
  } catch (error) {
    // Compacted history is immutable. It can still render a validated file,
    // without changing the sealed transcript or poisoning queued store writes.
    if (!(error instanceof RuntimeSidecarError) || error.code !== "READ_ONLY_HISTORY") throw error;
  }
  return restored;
}
