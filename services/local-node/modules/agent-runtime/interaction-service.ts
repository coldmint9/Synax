import { isDeepStrictEqual } from "node:util";
import { agentRuntimeStore as store } from "./session-store.js";
import { agentEventService as events } from "./event-service.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { AgentRuntimeError, AgentValidationError } from "./runtime-errors.js";
import {
  humanAskSchema,
  agentPlanSchema,
  interactionReplySchema,
  validateAnswers,
  type AgentPlan,
  type AgentInteraction,
  type InteractionReply,
} from "./control-contracts.js";
import { executeStoredPlan } from "./plan-execution.js";
import {
  createPlanArtifact,
  getPlanArtifact,
  updatePlanArtifact,
} from "./plan-artifact-store.js";

/** Injected on a skipped form: the model continues on its own recommendation
 *  instead of reading the skip as a refusal. */
const SKIP_MESSAGE =
  "The user skipped this form instead of answering. Do not treat it as a refusal and do not ask again: continue now with the intent you recommended while asking, preferring the options you marked as recommended and choosing sensible defaults for everything else.";

const conflict = (message: string): never => {
  throw new AgentRuntimeError(message, "INTERACTION_CONFLICT", 409);
};

/** A session parks on one checkpoint at a time, so its status only describes
 *  the newest one. A form stays answerable while the same run is merely held
 *  by another checkpoint (for example a permission prompt). */
function holdsForm(session: ReturnType<typeof store.getSession>): boolean {
  return ["waiting_input", "waiting_permission", "running"].includes(
    session.status,
  );
}

function runCanAnswer(
  session: ReturnType<typeof store.getSession>,
  runId: string,
): boolean {
  if (
    ["completed", "cancelled", "failed", "interrupted", "paused"].includes(
      session.status,
    )
  )
    return false;
  let active: string | null = session.activeRunId ?? null;
  if (!active) {
    active =
      store
        .listRuns(session.id)
        .find((run) =>
          ["waiting_input", "waiting_permission", "running"].includes(
            run.status,
          ),
        )?.id ?? null;
  }
  return active === runId;
}

type InteractionRequestInput = {
  sessionId: string;
  runId: string;
  stepId: string;
  toolCallId: string;
  kind: AgentInteraction["kind"];
  request: unknown;
};

function prepareInteraction(input: InteractionRequestInput): {
  request: AgentInteraction["request"];
  session: ReturnType<typeof store.getSession>;
  call: ReturnType<typeof store.getToolCall>;
  interaction: AgentInteraction;
} {
  const request: AgentInteraction["request"] =
    input.kind === "clarification"
      ? humanAskSchema.parse(input.request)
      : (() => {
          const raw = input.request as { plan: unknown };
          const plan = agentPlanSchema.parse(raw.plan);
          return { title: plan.title, plan };
        })();
  const session = store.getSession(input.sessionId);
  if (
    session.parentSessionId ||
    (!["synax", "goal"].includes(session.profileId) &&
      ((session.sessionMetadata?.backend as { id?: string } | undefined)?.id ?? "native") === "native")
  ) throw new AgentValidationError("Only the primary Synax agent can ask the user.");
  if (session.status !== "running" || session.activeRunId !== input.runId)
    conflict("The run is not active.");
  const call = store.getToolCall(input.sessionId, input.toolCallId);
  const approval = (request as AgentInteraction["request"]).approvalFor;
  if (approval && call.toolId === "goal.finish") {
    const plan = session.sessionMetadata?.plan as { revision: number; humanAcceptanceCriteria?: string[] } | undefined;
    if (!plan || approval.planRevision !== plan.revision || approval.criteria.some((c) => !plan.humanAcceptanceCriteria?.includes(c)))
      conflict("Invalid human acceptance request.");
    (request as AgentInteraction["request"]).approvalFor = approval;
  }
  if (call.runId !== input.runId || call.stepId !== input.stepId)
    conflict("Interaction checkpoint does not match the tool call.");
  const oldPlan = session.sessionMetadata?.plan as { revision?: number } | undefined;
  const revision = input.kind === "plan_approval"
    ? (getPlanArtifact(input.sessionId)?.revision ?? oldPlan?.revision ?? 0) + 1
    : 1;
  const interaction: AgentInteraction = {
    sessionId: input.sessionId,
    runId: input.runId,
    stepId: input.stepId,
    toolCallId: input.toolCallId,
    kind: input.kind,
    request,
    revision,
    id: makeRuntimeId("hitl"),
    status: "pending",
    response: null,
    createdAt: nowIso(),
    resolvedAt: null,
  };
  return { request, session, call, interaction };
}

function persistLocalInteraction(
  interaction: AgentInteraction,
  request: AgentInteraction["request"],
  call: ReturnType<typeof store.getToolCall>,
): AgentInteraction {
  return store.transaction(() => {
    store.saveRecord('interaction', interaction);
    if ("plan" in request) persistPlanProposal(interaction.sessionId, request.plan!);
    if (!store.listRunParts(interaction.stepId).some((p) => p.kind === "tool_call" && p.toolCallId === interaction.toolCallId))
      store.appendRunPart({
        id: makeRuntimeId("prt"),
        runId: interaction.runId,
        stepId: interaction.stepId,
        sessionId: interaction.sessionId,
        kind: "tool_call",
        sequence: store.nextRunPartSequence(interaction.stepId),
        content: `${call.toolId} ${call.inputSummary}`,
        toolCallId: interaction.toolCallId,
        metadata: { modelToolCallId: call.modelToolCallId },
        createdAt: nowIso(),
      });
    store.updateToolCall(interaction.sessionId, interaction.toolCallId, { status: "pending", endedAt: null });
    store.updateRunStep(interaction.stepId, { status: "waiting_input", finishReason: "human_input" });
    store.updateRun(interaction.runId, { status: "waiting_input", stopReason: "human_input" });
    store.updateSession(interaction.sessionId, {
      status: "waiting_input",
      pendingResumeToken: `interaction:${interaction.id}`,
      blockedReason: interaction.request.title,
    });
    events.append({
      sessionId: interaction.sessionId,
      type: "interaction_requested",
      summary: interaction.request.title,
      payload: { interactionId: interaction.id, runId: interaction.runId, stepId: interaction.stepId, toolCallId: interaction.toolCallId },
    });
    return interaction;
  });
}

export function persistPlanProposal(sessionId: string, plan: AgentPlan) {
  const artifact = createPlanArtifact({
    sessionId,
    plan,
    status: "draft",
  });
  const session = store.getSession(sessionId);
  store.updateSessionMetadata(sessionId, {
    plan: { ...artifact, status: "draft" },
  });
  const goal = session.sessionMetadata?.goal;
  if (
    session.sessionMetadata?.mode === "goal" &&
    goal &&
    typeof goal === "object"
  ) {
    store.updateSessionMetadata(sessionId, {
      goal: { ...goal, status: "planning" },
    });
  }
  return artifact;
}

export const interactionService = {
  list(sessionId: string): AgentInteraction[] {
    return store.listRecords<AgentInteraction>('interaction',sessionId).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  },
  pending(sessionId: string): AgentInteraction | null {
    return this.list(sessionId).find(i=>i.status==='pending')??null;
  },
  ready(sessionId: string): AgentInteraction | null {
    const session=store.getSession(sessionId);
    if(!holdsForm(session))return null;
    return this.list(sessionId).find(i=>i.runId===session.activeRunId&&['answered','cancelled'].includes(i.status)&&i.response&&!i.consumedAt)??null;
  },
  request(input: InteractionRequestInput): AgentInteraction {
    const prepared = prepareInteraction(input);
    if (this.pending(input.sessionId)) conflict("Resolve the current interaction first.");
    return store.transaction(() => {
      const value = persistLocalInteraction(prepared.interaction, prepared.request, prepared.call);
      store.enqueueControl(input.sessionId, `interaction-request:${value.id}`, 'interaction_request', value);
      return value;
    });
  },
  async requestAuthoritative(input: InteractionRequestInput): Promise<AgentInteraction> {
    await store.hydrateSession(input.sessionId);
    const value = this.request(input);
    await store.flushSession(input.sessionId);
    return store.getRecord<AgentInteraction>('interaction', value.id)!;
  },
  reply(sessionId: string, id: string, raw: unknown): AgentInteraction {
    const parsed = interactionReplySchema.parse(raw);
    const reply = parsed.action === 'skip' && !parsed.message?.trim() ? { ...parsed, message: SKIP_MESSAGE } : parsed;
    const interaction = store.transaction(() => {
      const i = store.getRecord<AgentInteraction>('interaction', id);
      if (!i || i.sessionId !== sessionId) throw new AgentRuntimeError("Interaction not found.", "NOT_FOUND", 404);
      const session = store.getSession(sessionId);
      if (reply.revision !== i.revision)
        conflict("The form is stale. Reload it before submitting.");
      if (i.status !== "pending") {
        if (
          isDeepStrictEqual(i.response, reply) &&
          session.status !== "cancelled"
        )
          return i;
        conflict("The interaction was already resolved or cancelled.");
      }
      if (!runCanAnswer(session, i.runId))
        conflict("This run no longer accepts input.");
      const validActions =
        i.kind === "clarification"
          ? ["submit", "skip", "cancel"]
          : ["execute", "cancel"];
      if (!validActions.includes(reply.action))
        throw new AgentValidationError("Invalid action for this interaction.");
      if (reply.action === "submit") {
        try {
          validateAnswers(i.request.questions ?? [], reply.answers);
        } catch (e) {
          throw new AgentValidationError((e as Error).message);
        }
      }
      if (reply.action === "submit" && i.request.approvalFor) {
        const plan = session.sessionMetadata?.plan as {
          revision: number;
          humanApprovedCriteria?: string[];
        };
        if (plan?.revision !== i.request.approvalFor.planRevision)
          conflict("Acceptance belongs to an older plan.");
        const accepted = i.request.approvalFor.criteria.filter(
          (_, index) => reply.answers?.[`acceptance_${index}`] === true,
        );
        store.updateSessionMetadata(sessionId, {
          plan: {
            ...plan,
            humanApprovedCriteria: [
              ...new Set([...(plan.humanApprovedCriteria ?? []), ...accepted]),
            ],
          },
        });
      }
      if (reply.action === "revise" && !reply.message?.trim())
        throw new AgentValidationError("Describe the requested plan changes.");
      if (i.kind === "plan_approval") {
        const plan = session.sessionMetadata?.plan as
          | { revision?: number }
          | undefined;
        if (plan?.revision !== i.revision)
          conflict("The plan revision changed.");
        if (reply.action === "execute") {
          executeStoredPlan({
            sessionId,
            runId: i.runId,
            stepId: i.stepId,
            expectedRevision: i.revision,
            allowWaitingInput: true,
          });
        } else if (reply.action === "cancel") {
          updatePlanArtifact(sessionId, i.revision, { status: "saved" });
          store.updateSessionMetadata(sessionId, {
            mode: session.sessionMetadata?.mode === "goal" ? "goal" : "chat",
            plan: { ...i.request.plan!, revision: i.revision, status: "saved" },
          });
        }
      }
      // Skipping is not refusing: the run keeps going, and the model is told to
      // fall back on the intent it recommended while asking.
      const response: InteractionReply =
        reply.action === "skip" && !reply.message?.trim()
          ? { ...reply, message: SKIP_MESSAGE }
          : reply;
      const status: AgentInteraction["status"] =
        reply.action === "cancel"
          ? "cancelled"
          : "answered";
      const resolvedAt = nowIso();
      store.saveRecord('interaction', { ...i, status, response, resolvedAt });
      events.append({
        sessionId,
        type: "interaction_resolved",
        summary: `${i.request.title}: ${reply.action}`,
        payload: { interactionId: id, runId: i.runId, action: reply.action },
      });
      return { ...i, status, response, resolvedAt };
    });
    store.enqueueControl(sessionId, `interaction-reply:${id}:${reply.revision}:${reply.action}`, 'interaction_reply',
      { id, revision: reply.revision, reply: interaction.response });
    return interaction;
  },
  async replyAuthoritative(sessionId: string, id: string, raw: unknown): Promise<AgentInteraction> {
    await store.hydrateSession(sessionId, true);
    this.reply(sessionId, id, raw);
    await store.flushSession(sessionId);
    return store.getRecord<AgentInteraction>('interaction', id)!;
  },
  deferPlan(sessionId: string, id: string): AgentInteraction {
    const interaction = store.transaction(() => {
      const i = store.getRecord<AgentInteraction>('interaction', id);
      if (!i || i.sessionId !== sessionId) throw new AgentRuntimeError("Interaction not found.", "NOT_FOUND", 404);
      if (i.kind !== "plan_approval")
        throw new AgentValidationError("Only a plan approval can be deferred.");
      if (i.status !== "pending")
        conflict("The interaction was already resolved or cancelled.");
      const session = store.getSession(sessionId);
      if (!runCanAnswer(session, i.runId))
        conflict("This run no longer accepts input.");
      const plan = session.sessionMetadata?.plan as
        | { revision?: number }
        | undefined;
      if (plan?.revision !== i.revision) conflict("The plan revision changed.");
      updatePlanArtifact(sessionId, i.revision, { status: "saved" });
      store.updateSessionMetadata(sessionId, {
        mode: session.sessionMetadata?.mode === "goal" ? "goal" : "chat",
        plan: { ...i.request.plan!, revision: i.revision, status: "saved" },
      });
      const reply: InteractionReply = { revision: i.revision, action: "save" };
      const resolvedAt = nowIso();
      store.saveRecord('interaction', { ...i, status: 'answered' as const, response: reply, resolvedAt });
      events.append({
        sessionId,
        type: "interaction_resolved",
        summary: `${i.request.title}: deferred`,
        payload: { interactionId: id, runId: i.runId, action: "save" },
      });
      return { ...i, status: "answered" as const, response: reply, resolvedAt };
    });
    store.enqueueControl(sessionId, `interaction-defer:${id}`, 'interaction_reply',
      { id, revision: interaction.revision, reply: interaction.response });
    return interaction;
  },
  consume(sessionId: string): AgentInteraction | null {
    const interaction = store.transaction(() => {
      const i = this.ready(sessionId);
      if (!i) return null;
      const summary = JSON.stringify({ kind: i.kind, ...i.response });
      store.updateToolCall(sessionId, i.toolCallId, {
        status: "completed",
        outputSummary: summary,
        outputRef: i.response,
        endedAt: nowIso(),
      });
      const existing = store
        .listRunParts(i.stepId)
        .some((p) => p.kind === "tool_result" && p.toolCallId === i.toolCallId);
      if (!existing)
        store.appendRunPart({
          id: makeRuntimeId("prt"),
          runId: i.runId,
          stepId: i.stepId,
          sessionId,
          kind: "tool_result",
          sequence: store.nextRunPartSequence(i.stepId),
          content: summary,
          toolCallId: i.toolCallId,
          metadata: {
            modelToolCallId: store.getToolCall(sessionId, i.toolCallId)
              .modelToolCallId,
            status: "completed",
          },
          createdAt: nowIso(),
        });
      store.updateRunStep(i.stepId, {
        status: "completed",
        completedAt: nowIso(),
        finishReason: "human_input_resolved",
      });
      store.saveRecord('interaction', { ...i, consumedAt: nowIso() });
      store.updateRun(i.runId, {
        status: "running",
        completedAt: null,
        stopReason: null,
      });
      store.updateSession(sessionId, {
        status: "running",
        pendingResumeToken: null,
        blockedReason: null,
      });
      return i;
    });
    if (interaction) store.enqueueControl(sessionId, `interaction-consume:${interaction.id}`, 'interaction_consume', { id: interaction.id });
    return interaction;
  },
  async consumeAuthoritative(sessionId: string): Promise<AgentInteraction | null> {
    await store.hydrateSession(sessionId, true);
    const value = this.consume(sessionId);
    await store.flushSession(sessionId);
    return value ? store.getRecord<AgentInteraction>('interaction', value.id)! : null;
  },
  cancel(sessionId: string): void {
    store.transaction(() => {
      for (const interaction of this.list(sessionId).filter(value => !value.consumedAt && (value.status === 'pending' || value.response))) {
        const now = nowIso();
        store.saveRecord('interaction', { ...interaction, status: 'cancelled' as const, resolvedAt: now, consumedAt: now });
        store.enqueueControl(sessionId, `interaction-cancel:${interaction.id}`, 'interaction_cancel', { id: interaction.id });
      }
    });
  },
};
