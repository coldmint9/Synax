import { historyRevision, historyError } from "./checkpoints/guards.js";
import type { AgentSessionStreamMode } from "../../lib/ipc/agent-session-protocol.js";
import type { AgentRunStreamChunk, StreamTurnRequest } from "./contracts.js";
import {
  resolveBackendModel,
  resolveSessionBackend,
} from "./backends/backend-binding.js";
import { getBackendAdapter } from "./backends/backend-registry.js";
import { agentRuntimeStore } from "./session-store.js";
import { AgentValidationError } from "./runtime-errors.js";
import {
  ensureSessionTitleGenerated,
  maybeScheduleSessionTitleFromStreamChunk,
} from "./session-title-service.js";

/** The caller owns this signal. A browser observer must never pass its connection signal here. */
export async function* executeBackendSession(
  sessionId: string,
  mode: AgentSessionStreamMode,
  input: StreamTurnRequest,
  signal?: AbortSignal,
): AsyncGenerator<AgentRunStreamChunk> {
  const revision = historyRevision(sessionId);
  const binding = resolveSessionBackend(sessionId);
  const model = resolveBackendModel(sessionId, input);
  const metadata = agentRuntimeStore.getSession(sessionId).sessionMetadata;
  if (
    binding.id !== "native" &&
    (metadata?.mode === "plan" || (metadata?.mode === "goal" && metadata.goal))
  ) {
    throw new AgentValidationError(
      "Plan and goal controls require the native Synax engine.",
    );
  }
  if (binding.id !== "native" && input.referenceContext?.content) {
    input = {
      ...input,
      message: `${input.message ?? ""}\n\n<user-selected-references>\n${input.referenceContext.content}\n</user-selected-references>`,
    };
  }
  try {
    for await (const chunk of getBackendAdapter(binding.id).stream(
      sessionId,
      mode,
      model ? { ...input, model } : input,
      signal,
    )) {
      if (historyRevision(sessionId) !== revision)
        throw historyError("Obsolete conversation execution.", "HISTORY_STALE");
      maybeScheduleSessionTitleFromStreamChunk(sessionId, chunk);
      yield chunk;
    }
  } finally {
    ensureSessionTitleGenerated(sessionId);
  }
}
