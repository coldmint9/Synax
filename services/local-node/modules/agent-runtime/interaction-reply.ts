import type { AgentInteraction, InteractionReply } from "./control-contracts.js";
import { interactionService } from "./interaction-service.js";
import { runCoordinator, type RunCoordinator } from "./run-coordinator.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import { agentRuntimeStore as store } from "./session-store.js";

const replies = new Map<string, Promise<AgentInteraction>>();

/** Serialize retries through persistence and admission, including a lost HTTP response. */
export async function replyAndContinueInteraction(
  sessionId: string,
  id: string,
  reply: InteractionReply,
  coordinator: RunCoordinator = runCoordinator,
): Promise<AgentInteraction> {
  const previous = replies.get(sessionId);
  const task = (async () => {
    await previous?.catch(() => {});
    await store.hydrateSession(sessionId, true);
    if (store.getSession(sessionId).sessionMetadata?.runtimeControl)
      throw new AgentRuntimeError("Execution is stopping or requires recovery.", "RECOVERY_REQUIRED", 409);
    let interaction = await interactionService.replyAuthoritative(sessionId, id, reply);
    if (!interaction.restartRequestId) {
      if (interactionService.ready(sessionId)) coordinator.resume(sessionId);
      return interaction;
    }

    interaction = await interactionService.consumeForRestart(sessionId, id);
    if (interaction.response?.action === "cancel") return interaction;
    // A fresh admitted turn uses canonical history and does not need the old
    // Rust loop or its execution lease to have survived an application restart.
    await coordinator.submitAsync(sessionId, {
      message: [
        "Continue the existing task using my reply to the saved form below. The previous run ended before this reply was submitted.",
        JSON.stringify({ title: interaction.request.title, questions: interaction.request.questions,
          response: interaction.response }),
      ].join("\n\n"),
      messageSource: "user",
    }, interaction.restartRequestId!);
    return interaction;
  })();
  replies.set(sessionId, task);
  try {
    return await task;
  } finally {
    if (replies.get(sessionId) === task) replies.delete(sessionId);
  }
}
