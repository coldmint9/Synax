import { logger } from "../../infrastructure/runtime/logger.js";
import type { RuntimeBusEvent } from "./runtime-bus.js";
import { invalidateSessionEnvironmentCards } from "./session-environment-cards.js";
import { agentRuntimeStore } from "./session-store.js";
import { clearSessionWorkspaceRoot } from "./tools/workspace.js";
import { invalidateWorkspaceGitForSession } from "./workspace-git-changes.js";

function bindingPatch(event: RuntimeBusEvent): unknown {
  if (event.type !== "session_changed") return undefined;
  const sessionMetadata = (
    event.patch as { sessionMetadata?: { backend?: unknown } } | undefined
  )?.sessionMetadata;
  return sessionMetadata?.backend;
}

/**
 * Mirror a checkout switch performed inside a session worker.
 *
 * The agent binds its own worktree in the worker process, but the workspace
 * panel reads this process's session copy, the membership cache and the Git
 * facts derived from them. Without this mirror the panel keeps describing the
 * previous checkout, and its branch collapses to a bare `HEAD` because the Git
 * facts no longer match the reported root path.
 *
 * Must run before the event reaches clients so their refetch already sees the
 * new binding.
 */
export async function syncWorkerSessionBinding(
  event: RuntimeBusEvent,
): Promise<void> {
  if (bindingPatch(event) === undefined) return;
  try {
    // The worker patched the durable projection, not this process's copy.
    await agentRuntimeStore.hydrateSessionSummary(event.sessionId, true);
  } catch (error) {
    logger.warn(
      { sessionId: event.sessionId, error },
      "Session workspace binding refresh failed",
    );
  }
  clearSessionWorkspaceRoot(event.sessionId);
  invalidateSessionEnvironmentCards(event.sessionId);
  invalidateWorkspaceGitForSession(event.sessionId);
}
