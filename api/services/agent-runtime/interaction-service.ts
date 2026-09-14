import { isDeepStrictEqual } from "node:util";
import { getRawSqlite } from "../../db/index.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { agentEventService as events } from "./event-service.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { AgentRuntimeError, AgentValidationError } from "./runtime-errors.js";
import {
  humanAskSchema,
  agentPlanSchema,
  interactionReplySchema,
  validateAnswers,
  type AgentInteraction,
  type InteractionReply,
} from "./control-contracts.js";
import { executeStoredPlan } from "./plan-execution.js";

type Row = {
  id: string;
  session_id: string;
  run_id: string;
  step_id: string;
  tool_call_id: string;
  kind: AgentInteraction["kind"];
  revision: number;
  status: AgentInteraction["status"];
  request_json: string;
  response_json: string | null;
  created_at: string;
  resolved_at: string | null;
};
const map = (r: Row): AgentInteraction => ({
  id: r.id,
  sessionId: r.session_id,
  runId: r.run_id,
  stepId: r.step_id,
  toolCallId: r.tool_call_id,
  kind: r.kind,
  revision: r.revision,
  status: r.status,
  request: JSON.parse(r.request_json),
  response: r.response_json ? JSON.parse(r.response_json) : null,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});
const conflict = (message: string): never => {
  throw new AgentRuntimeError(message, "INTERACTION_CONFLICT", 409);
};

export const interactionService = {
  list(sessionId: string): AgentInteraction[] {
    store.getSession(sessionId);
    return (
      getRawSqlite()
        .prepare(
          "SELECT * FROM agent_runtime_interactions WHERE session_id = ? ORDER BY created_at, rowid",
        )
        .all(sessionId) as Row[]
    ).map(map);
  },
  pending(sessionId: string): AgentInteraction | null {
    const row = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_interactions WHERE session_id = ? AND status = 'pending'",
      )
      .get(sessionId) as Row | undefined;
    return row ? map(row) : null;
  },
  ready(sessionId: string): AgentInteraction | null {
    const row = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_interactions WHERE session_id = ? AND status != 'pending' AND response_json IS NOT NULL AND consumed_at IS NULL ORDER BY rowid DESC LIMIT 1",
      )
      .get(sessionId) as Row | undefined;
    if (!row) return null;
    const session = store.getSession(sessionId);
    return session.status === "waiting_input" &&
      session.activeRunId === row.run_id
      ? map(row)
      : null;
  },
  request(input: {
    sessionId: string;
    runId: string;
    stepId: string;
    toolCallId: string;
    kind: AgentInteraction["kind"];
    request: unknown;
  }): AgentInteraction {
    const request: AgentInteraction["request"] =
      input.kind === "clarification"
        ? humanAskSchema.parse(input.request)
        : (() => {
            const raw = input.request as { plan: unknown };
            const plan = agentPlanSchema.parse(raw.plan);
            return { title: plan.title, plan };
          })();
    return getRawSqlite().transaction(() => {
      const session = store.getSession(input.sessionId);
      if (
        session.parentSessionId ||
        (!["synax", "goal"].includes(session.profileId) &&
          ((session.sessionMetadata?.backend as { id?: string } | undefined)?.id ?? 'native') === 'native')
      )
        throw new AgentValidationError(
          "Only the primary Synax agent can ask the user.",
        );
      if (session.status !== "running" || session.activeRunId !== input.runId)
        conflict("The run is not active.");
      const call = store.getToolCall(input.sessionId, input.toolCallId);
      const approval = (input.request as AgentInteraction["request"])
        .approvalFor;
      if (approval && call.toolId === "goal.finish") {
        const plan = session.sessionMetadata?.plan as
          | { revision: number; humanAcceptanceCriteria?: string[] }
          | undefined;
        if (
          !plan ||
          approval.planRevision !== plan.revision ||
          approval.criteria.some(
            (c) => !plan.humanAcceptanceCriteria?.includes(c),
          )
        )
          conflict("Invalid human acceptance request.");
        request.approvalFor = approval;
      }
      if (call.runId !== input.runId || call.stepId !== input.stepId)
        conflict("Interaction checkpoint does not match the tool call.");
      const previous = this.pending(input.sessionId);
      if (previous) conflict("Resolve the current interaction first.");
      const oldPlan = session.sessionMetadata?.plan as
        | { revision?: number }
        | undefined;
      const revision =
        input.kind === "plan_approval" ? (oldPlan?.revision ?? 0) + 1 : 1;
      const i: AgentInteraction = {
        ...input,
        request,
        revision,
        id: makeRuntimeId("hitl"),
        status: "pending",
        response: null,
        createdAt: nowIso(),
        resolvedAt: null,
      };
      getRawSqlite()
        .prepare(
          "INSERT INTO agent_runtime_interactions (id,session_id,run_id,step_id,tool_call_id,kind,revision,status,request_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          i.id,
          i.sessionId,
          i.runId,
          i.stepId,
          i.toolCallId,
          i.kind,
          i.revision,
          i.status,
          JSON.stringify(i.request),
          i.createdAt,
        );
      if ("plan" in request) {
        store.updateSessionMetadata(i.sessionId, {
          plan: { ...request.plan, revision, status: "draft" },
        });
        const goal = session.sessionMetadata?.goal;
        if (goal && typeof goal === "object")
          store.updateSessionMetadata(i.sessionId, {
            goal: { ...goal, status: "planning" },
          });
      }
      if (
        !store
          .listRunParts(i.stepId)
          .some((p) => p.kind === "tool_call" && p.toolCallId === i.toolCallId)
      )
        store.appendRunPart({
          id: makeRuntimeId("prt"),
          runId: i.runId,
          stepId: i.stepId,
          sessionId: i.sessionId,
          kind: "tool_call",
          sequence: store.nextRunPartSequence(i.stepId),
          content: `${call.toolId} ${call.inputSummary}`,
          toolCallId: i.toolCallId,
          metadata: { modelToolCallId: call.modelToolCallId },
          createdAt: nowIso(),
        });
      store.updateToolCall(i.sessionId, i.toolCallId, {
        status: "pending",
        endedAt: null,
      });
      store.updateRunStep(i.stepId, {
        status: "waiting_input",
        finishReason: "human_input",
      });
      store.updateRun(i.runId, {
        status: "waiting_input",
        stopReason: "human_input",
      });
      store.updateSession(i.sessionId, {
        status: "waiting_input",
        pendingResumeToken: `interaction:${i.id}`,
        blockedReason: i.request.title,
      });
      events.append({
        sessionId: i.sessionId,
        type: "interaction_requested",
        summary: i.request.title,
        payload: {
          interactionId: i.id,
          runId: i.runId,
          stepId: i.stepId,
          toolCallId: i.toolCallId,
        },
      });
      return i;
    })();
  },
  reply(sessionId: string, id: string, raw: unknown): AgentInteraction {
    const reply = interactionReplySchema.parse(raw);
    return getRawSqlite().transaction(() => {
      const row = getRawSqlite()
        .prepare(
          "SELECT * FROM agent_runtime_interactions WHERE id = ? AND session_id = ?",
        )
        .get(id, sessionId) as Row | undefined;
      if (!row)
        throw new AgentRuntimeError("Interaction not found.", "NOT_FOUND", 404);
      const i = map(row),
        session = store.getSession(sessionId);
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
      if (session.status !== "waiting_input" || session.activeRunId !== i.runId)
        conflict("This run no longer accepts input.");
      const validActions =
        i.kind === "clarification"
          ? ["submit", "decline", "cancel"]
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
        } else if (reply.action === "cancel")
          store.updateSessionMetadata(sessionId, {
            mode: "plan",
            plan: { ...i.request.plan!, revision: i.revision, status: "saved" },
          });
      }
      const status: AgentInteraction["status"] =
        reply.action === "cancel"
          ? "cancelled"
          : reply.action === "decline"
            ? "declined"
            : "answered";
      const resolvedAt = nowIso();
      getRawSqlite()
        .prepare(
          "UPDATE agent_runtime_interactions SET status=?, response_json=?,resolved_at=? WHERE id=? AND status='pending'",
        )
        .run(status, JSON.stringify(reply), resolvedAt, id);
      events.append({
        sessionId,
        type: "interaction_resolved",
        summary: `${i.request.title}: ${reply.action}`,
        payload: { interactionId: id, runId: i.runId, action: reply.action },
      });
      return { ...i, status, response: reply, resolvedAt };
    })();
  },
  deferPlan(sessionId: string, id: string): AgentInteraction {
    return getRawSqlite().transaction(() => {
      const row = getRawSqlite()
        .prepare("SELECT * FROM agent_runtime_interactions WHERE id = ? AND session_id = ?")
        .get(id, sessionId) as Row | undefined;
      if (!row) throw new AgentRuntimeError("Interaction not found.", "NOT_FOUND", 404);
      const i = map(row);
      if (i.kind !== "plan_approval")
        throw new AgentValidationError("Only a plan approval can be deferred.");
      if (i.status !== "pending")
        conflict("The interaction was already resolved or cancelled.");
      const session = store.getSession(sessionId);
      if (session.status !== "waiting_input" || session.activeRunId !== i.runId)
        conflict("This run no longer accepts input.");
      const plan = session.sessionMetadata?.plan as { revision?: number } | undefined;
      if (plan?.revision !== i.revision)
        conflict("The plan revision changed.");
      store.updateSessionMetadata(sessionId, {
        mode: "plan",
        plan: { ...i.request.plan!, revision: i.revision, status: "saved" },
      });
      const reply: InteractionReply = { revision: i.revision, action: "save" };
      const resolvedAt = nowIso();
      getRawSqlite()
        .prepare("UPDATE agent_runtime_interactions SET status='answered',response_json=?,resolved_at=? WHERE id=? AND status='pending'")
        .run(JSON.stringify(reply), resolvedAt, id);
      events.append({
        sessionId,
        type: "interaction_resolved",
        summary: `${i.request.title}: deferred`,
        payload: { interactionId: id, runId: i.runId, action: "save" },
      });
      return { ...i, status: "answered" as const, response: reply, resolvedAt };
    })();
  },
  consume(sessionId: string): AgentInteraction | null {
    return getRawSqlite().transaction(() => {
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
      getRawSqlite()
        .prepare(
          "UPDATE agent_runtime_interactions SET consumed_at=? WHERE id=? AND consumed_at IS NULL",
        )
        .run(nowIso(), i.id);
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
    })();
  },
  cancel(sessionId: string): void {
    getRawSqlite()
      .prepare(
        "UPDATE agent_runtime_interactions SET status='cancelled',resolved_at=?,consumed_at=? WHERE session_id=? AND consumed_at IS NULL",
      )
      .run(nowIso(), nowIso(), sessionId);
  },
};
