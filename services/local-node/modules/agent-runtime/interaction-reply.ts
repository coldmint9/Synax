import type { AgentInteraction, InteractionReply } from "./control-contracts.js";
import { interactionService } from "./interaction-service.js";
import { runCoordinator, type RunCoordinator } from "./run-coordinator.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";

const replies = new Map<string, Promise<AgentInteraction>>();

/** A form whose run ended before the answer was submitted continues in a fresh
 *  admitted turn. The identity is derived from the form, so a control echo that
 *  replaces the annotated record cannot lose it. */
function continuationRequestId(interaction: AgentInteraction): string | undefined {
  if (interaction.status !== "answered") return undefined;
  if (interaction.restartRequestId) return interaction.restartRequestId;
  const activeRunId = store.getSession(interaction.sessionId).activeRunId;
  return activeRunId === interaction.runId
    ? undefined
    : `interaction-restart:${interaction.id}`;
}

/** A retried reply must converge on the turn the first attempt admitted, not
 *  submit the same request identity again with a fresh run document. */
function continuationAdmitted(sessionId: string, requestId: string): boolean {
  return store.listRuns(sessionId).some(
    (run) =>
      (run.metadata.runtime as { requestId?: string } | undefined)?.requestId ===
      requestId,
  );
}

/** Cancelling a question whose run already ended must not leave the session
 *  parked forever: the composer is locked while a session reports
 *  `waiting_input`, and the cancelled form is no longer offered. Pausing keeps
 *  the session resumable instead of hiding it behind an unsatisfiable form. */
async function closeParkedQuestion(
  sessionId: string,
  interaction: AgentInteraction,
): Promise<void> {
  const session = store.getSession(sessionId);
  if (session.activeRunId || session.status !== "waiting_input") return;
  if (session.pendingResumeToken !== `interaction:${interaction.id}`) return;
  await runtimeFacade.stopSessionAuthoritative(
    sessionId,
    "paused",
    "The saved question was cancelled.",
  );
}

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
    const restartRequestId = continuationRequestId(interaction);
    if (!restartRequestId) {
      if (interaction.status === "cancelled")
        await closeParkedQuestion(sessionId, interaction);
      else if (interactionService.ready(sessionId)) coordinator.resume(sessionId);
      return interaction;
    }

    interaction = await interactionService.consumeForRestart(sessionId, id);
    if (interaction.response?.action === "cancel") return interaction;
    if (continuationAdmitted(sessionId, restartRequestId)) return interaction;
    // A fresh admitted turn uses canonical history and does not need the old
    // Rust loop or its execution lease to have survived an application restart.
    await coordinator.submitAsync(sessionId, {
      message: [
        "Continue the existing task using my reply to the saved form below. The previous run ended before this reply was submitted.",
        JSON.stringify({ title: interaction.request.title, questions: interaction.request.questions,
          response: interaction.response }),
      ].join("\n\n"),
      messageSource: "user",
    }, restartRequestId);
    return interaction;
  })();
  replies.set(sessionId, task);
  try {
    return await task;
  } finally {
    if (replies.get(sessionId) === task) replies.delete(sessionId);
  }
}
