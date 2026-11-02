import { agentRuntimeApi } from "../../adapters/transport/agentRuntime";
import { useSessionWorkspaceStore } from "./state/sessionWorkspaceStore";

/** One discovery per conversation; StrictMode and re-renders share it. */
const inFlight = new Set<string>();

/**
 * Adopt the side chat the runtime already stores for this conversation.
 *
 * A collapsed side chat is layout, so selecting a conversation restores its
 * pill without opening anything. The lookup never creates a side chat: a
 * conversation without one simply has no pill.
 */
export function discoverSideChatSession(parentSessionId: string): void {
  if (!parentSessionId || inFlight.has(parentSessionId)) return;
  inFlight.add(parentSessionId);
  void agentRuntimeApi
    .readSideChat(parentSessionId)
    .then(({ session }) => {
      if (session)
        useSessionWorkspaceStore
          .getState()
          .discoverSideChat(parentSessionId, session.id);
    })
    .catch(() => {
      // The pill is an affordance, not a read gate: a failed lookup only means
      // the conversation shows no stored side chat until one is opened.
    })
    .finally(() => inFlight.delete(parentSessionId));
}
