import { agentRuntimeStore as store } from "./session-store.js";
import { resolveSessionBackend } from "./backends/backend-binding.js";
import { AgentRuntimeError, AgentValidationError } from "./runtime-errors.js";
import { projectWorkContext } from "./context-projection.js";
import { buildLoopToolSet } from "./loop-ai-tools.js";
import { toolRegistry } from "./tool-registry.js";
import { runtimeTransaction } from "./runtime-transaction.js";

/** Only idle Synax sessions can commit a new boundary outside a model request. */
export function compactSessionContext(sessionId: string) {
  return runtimeTransaction(() => {
    const session = store.getSession(sessionId);
    if (resolveSessionBackend(sessionId).id !== "native") {
      throw new AgentValidationError(
        "This backend manages its own context compaction.",
      );
    }
    const activeStates = new Set([
      "queued",
      "running",
      "stopping",
      "waiting_permission",
      "waiting_input",
    ]);
    const control = session.sessionMetadata?.runtimeControl as
      | { state?: string }
      | undefined;
    if (
      activeStates.has(session.status) ||
      ["stopping", "unconfirmed"].includes(control?.state ?? "") ||
      store.listRuns(sessionId).some((run) => activeStates.has(run.status))
    ) {
      throw new AgentRuntimeError(
        "Wait for the current run to finish before compacting context.",
        "SESSION_BUSY",
        409,
      );
    }
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
      reason: projection.compaction?.reason ?? "no-compressible-history",
    };
  });
}
