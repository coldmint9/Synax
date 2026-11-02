import { agentRuntimeApi } from "../../../adapters/transport/agentRuntime";
import { useShellStore } from "../../../shared/state/shellStore";
import { canEnqueueSessionInput } from "../sessionComposerState";
import { useAgentSessionStore, type SessionInputBody } from "./agentSessionStore";
import type { ConversationController } from "./conversationController";
import { conversationTurnMode, submitConversationMessage } from "./submitConversationMessage";

/** Commands target the retained child without changing workspace selection or list. */
export function conversationActions(controller: ConversationController) {
  const assertOwner = (sessionId: string) => {
    if (sessionId !== controller.sessionId) throw new Error("Conversation scope changed.");
  };
  return {
    async submitOrEnqueueSessionInput(sessionId: string, body: SessionInputBody): Promise<"sent" | "queued"> {
      assertOwner(sessionId);
      const session = controller.getSnapshot().session;
      if (!session) throw new Error("Conversation is still loading.");
      if (canEnqueueSessionInput(session)) {
        await agentRuntimeApi.enqueueInput(sessionId, body);
        await useAgentSessionStore.getState().loadInputQueue(sessionId);
        return "queued";
      }
      const { run } = await submitConversationMessage(sessionId, {
        message: body.message, contentParts: body.contentParts, references: body.references,
        messageSource: body.messageSource, model: body.model ?? undefined,
        reasoningEffort: body.reasoningEffort ?? undefined,
        locale: useShellStore.getState().preferences.locale,
      }, conversationTurnMode(session));
      controller.acceptRun(run);
      void controller.refresh();
      return "sent";
    },
    async cancelSessionRun(sessionId: string) {
      assertOwner(sessionId);
      await agentRuntimeApi.cancelSession(sessionId, controller.getSnapshot().session?.activeRunId ?? undefined);
      await controller.refresh();
    },
    async resumeSession(sessionId: string, message?: string) {
      assertOwner(sessionId);
      const { run } = await agentRuntimeApi.submitRun(sessionId,
        { message, locale: useShellStore.getState().preferences.locale }, crypto.randomUUID(), "continue");
      controller.acceptRun(run);
      void controller.refresh();
    },
  };
}
