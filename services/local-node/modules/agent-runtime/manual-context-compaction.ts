import { agentRuntimeStore as store } from "./session-store.js";
import { resolveSessionBackend } from "./backends/backend-binding.js";
import { AgentRuntimeError, AgentValidationError } from "./runtime-errors.js";
import { projectWorkContext } from "./context-projection.js";
import { buildLoopToolSet } from "./loop-ai-tools.js";
import { toolRegistry } from "./tool-registry.js";
import { maybeLlmCompactContext } from "./llm-context-compaction.js";

export interface ContextCompactionResult {
  compacted: boolean;
  originalTokens: number;
  tokens: number;
  messageCount: number;
  reason: string;
}

const ACTIVE_STATES = new Set([
  "queued",
  "running",
  "stopping",
  "waiting_permission",
  "waiting_input",
]);

/** Validate the durable session state without opening a write transaction. */
export function assertSessionCanCompact(sessionId: string): void {
  const session = store.getSession(sessionId);
  if (resolveSessionBackend(sessionId).id !== "native") {
    throw new AgentValidationError(
      "This backend manages its own context compaction.",
    );
  }
  const control = session.sessionMetadata?.runtimeControl as
    | { state?: string }
    | undefined;
  if (
    ACTIVE_STATES.has(session.status) ||
    ["stopping", "unconfirmed"].includes(control?.state ?? "") ||
    store.listRuns(sessionId).some((run) => ACTIVE_STATES.has(run.status))
  ) {
    throw new AgentRuntimeError(
      "Wait for the current run to finish before compacting context.",
      "SESSION_BUSY",
      409,
    );
  }
}

/** Runs inside an agent worker. CPU-heavy projection stays off the API event loop. */
export function compactSessionContext(
  sessionId: string,
): ContextCompactionResult {
  assertSessionCanCompact(sessionId);
  const stats = store.getSessionStats(sessionId);
  const projection = projectWorkContext({
    sessionId,
    toolSet: buildLoopToolSet(toolRegistry.listForSession(sessionId)),
    contextLimit: stats.contextLimit,
    outputReserve: Math.min(8192, Math.floor(stats.contextLimit / 4)),
    systemTokens: 0,
    model: resolveSessionBackend(sessionId).model ?? undefined,
    forceCompact: true,
  });
  return {
    compacted: projection.compacted,
    originalTokens: projection.originalTokens,
    tokens: projection.tokens,
    messageCount: projection.messages.length,
    reason: projection.compaction?.reason ?? "no-compressible-history",
  };
}

/** Manual compaction variant used by the API worker, including the configured LLM summary. */
export async function compactSessionContextWithLlm(
  sessionId: string,
): Promise<ContextCompactionResult> {
  assertSessionCanCompact(sessionId);
  const session = store.getSession(sessionId);
  const stats = store.getSessionStats(sessionId);
  const result = await maybeLlmCompactContext({
    sessionId,
    projectId: session.projectId,
    runId: null,
    toolSet: buildLoopToolSet(toolRegistry.listForSession(sessionId)),
    contextLimit: stats.contextLimit,
    outputReserve: Math.min(8192, Math.floor(stats.contextLimit / 4)),
    systemTokens: 0,
    model: resolveSessionBackend(sessionId).model ?? undefined,
    force: true,
  });
  return {
    compacted: result.didCompact,
    originalTokens: result.projection.originalTokens,
    tokens: result.projection.tokens,
    messageCount: result.projection.messages.length,
    reason: result.projection.compaction?.reason ?? "no-compressible-history",
  };
}
