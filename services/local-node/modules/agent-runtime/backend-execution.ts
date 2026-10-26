import type { AgentSessionStreamMode } from "../../infrastructure/runtime/ipc/agent-session-protocol.js";
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
  await agentRuntimeStore.hydrateSession(sessionId);
  const binding = resolveSessionBackend(sessionId);
  const model = resolveBackendModel(sessionId, input);
  if (binding.id !== "native")
    throw new AgentValidationError(
      "External CLI and ACP engines have been removed. Start a native Synax session.",
    );
  try {
    for await (const chunk of getBackendAdapter(binding.id).stream(
      sessionId,
      mode,
      model ? { ...input, model } : input,
      signal,
    )) {
      signal?.throwIfAborted();
      maybeScheduleSessionTitleFromStreamChunk(sessionId, chunk);
      yield chunk;
    }
  } finally {
    ensureSessionTitleGenerated(sessionId);
  }
}
