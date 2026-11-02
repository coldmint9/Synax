import type { AgentRunStep, AgentRuntimeMessage } from "./contracts.js";
import { nowIso } from "./runtime-ids.js";
import { snapshotRuntimeReminder } from "./runtime-request-snapshot.js";
import { agentRuntimeStore as store } from "./session-store.js";

/** Append once before dispatch; retries and worker recovery reuse the exact bytes.
 * Stored as runtime state, not a human turn. The native provider projection uses
 * an input message so adapters cannot hoist this state into the system prefix.
 */
export function persistNativeRuntimeReminder(
  step: Pick<AgentRunStep, "id" | "sessionId" | "runId">,
  sections: string[],
): AgentRuntimeMessage | undefined {
  const id = `runtime-reminder:${step.id}`;
  const saved = store.getMessage(step.sessionId, id);
  if (saved) return saved;
  const snapshot = snapshotRuntimeReminder({}, sections, []);
  if (!snapshot.content) return undefined;
  return store.appendMessage({
    id, sessionId: step.sessionId, runId: step.runId, stepId: step.id,
    role: "system", content: snapshot.content, createdAt: nowIso(),
    metadata: {
      source: "runtime_reminder",
      rustMessage: { role: "user", content: [{ type: "text", text: snapshot.content }] },
    },
  });
}
