import * as z from "zod/v4";
import type { RegisteredTool, ToolExecutionInput, ToolExecutionResult } from "./contracts.js";
import { AgentValidationError } from "./runtime-errors.js";
import { agentRuntimeStore } from "./session-store.js";
import { agentSessionRuntime } from "./session-runtime.js";
import {
  getSubagentLiveness,
  runChildToCompletion,
  type SubagentSpec,
} from "./subagent-orchestrator.js";
import { nowIso } from "./runtime-ids.js";
import { interruptAgentSessionsAndWait } from "./agent-stream-proxy.js";
import { createConfiguredSubagent } from "./subagent-delegation.js";
import { subagentStartFields } from "./subagent-config.js";
import { runtimeFacade } from "./sidecar/runtime-facade.js";
import { subagentCompletionBroker, readSubagentControl } from "./subagent-control-broker.js";

const activeRuns = new Set<string>();
const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);

const lifecycleActions = [
  "start",
  "list",
  "inspect",
  "wait",
  "message",
  "pause",
  "resume",
  "cancel",
  "terminate",
  "close",
] as const;

const startOnlyFields = ["prompt", "profile", "templateId", "name", "deliverable", "acceptanceCriteria"] as const;
const childOnlyFields = ["childSessionId", "timeoutMs", "message", "reason"] as const;

/**
 * Keep a flat object schema instead of a discriminated union: a union
 * serializes to a root `oneOf` with no `type`, and OpenAI-compatible providers
 * reject such tool parameters ("schema must be a JSON Schema of 'type:
 * \"object\"', got 'type: null'"). Per-action requirements are enforced by the
 * refinement below and documented on the fields, so the model still sees one
 * object schema with a required `action`.
 */
const lifecycleArgsSchema = z
  .object({
    action: z
      .enum(lifecycleActions)
      .describe("Lifecycle action to perform on a subagent."),
    ...subagentStartFields,
    prompt: subagentStartFields.prompt.optional(),
    childSessionId: z.string().min(1).max(64).optional().describe(
      "Required for every action except start and list; use the childSessionId returned by start or list.",
    ),
    timeoutMs: z.number().int().min(0).max(30_000).optional().describe(
      "wait only: wait budget in milliseconds, 5000 when omitted.",
    ),
    message: z.string().trim().min(1).max(100_000).optional().describe(
      "message only, required there: new instruction for a stopped or completed child.",
    ),
    reason: z.string().trim().min(1).max(4_000).optional().describe(
      "Optional reason recorded with pause, cancel, terminate or close.",
    ),
  })
  .superRefine((value, context) => {
    const reject = (fields: readonly (keyof typeof value)[], action: string) => {
      for (const field of fields)
        if (value[field] !== undefined)
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${field} is not accepted for action ${action}.`,
          });
    };
    if (value.action === "start") {
      if (!value.prompt)
        context.addIssue({
          code: "custom",
          path: ["prompt"],
          message: "prompt is required for action start.",
        });
      reject(childOnlyFields, "start");
      return;
    }
    if (value.action === "list") {
      reject(startOnlyFields, "list");
      reject(childOnlyFields, "list");
      return;
    }
    if (!value.childSessionId)
      context.addIssue({
        code: "custom",
        path: ["childSessionId"],
        message: `childSessionId is required for action ${value.action}.`,
      });
    reject(startOnlyFields, value.action);
    if (value.action === "message" && !value.message)
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "message is required for action message.",
      });
  });

type LifecycleArgs = z.infer<typeof lifecycleArgsSchema>;

function requiredChildSessionId(args: LifecycleArgs): string {
  if (!args.childSessionId)
    throw new AgentValidationError(
      "childSessionId is required for this lifecycle action.",
    );
  return args.childSessionId;
}

function assertOwnedChild(parentSessionId: string, childSessionId: string) {
  const child = agentRuntimeStore.tryGetSession(childSessionId);
  if (!child || child.parentSessionId !== parentSessionId)
    throw new AgentValidationError(
      "The requested subagent is not a child of the current session.",
    );
  return child;
}

function childView(childSessionId: string, parentSessionId: string) {
  const child = assertOwnedChild(parentSessionId, childSessionId);
  const metadata = child.sessionMetadata?.subagentTask as
    | Record<string, unknown>
    | undefined;
  return {
    childSessionId: child.id,
    parentSessionId: child.parentSessionId,
    profileId: child.profileId,
    name: child.sessionMetadata?.subagentName ?? null,
    status: child.status,
    liveness: getSubagentLiveness(child.status, metadata),
    summary: child.resultSummary ?? null,
    error: child.blockedReason ?? null,
    metadata: metadata ?? null,
    control: readSubagentControl(child),
    activeRunId: child.activeRunId,
  };
}

function result(result: unknown, displaySummary: string): ToolExecutionResult {
  return { result, displaySummary, artifacts: [] };
}

async function waitForChild(
  parentSessionId: string,
  childSessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  assertOwnedChild(parentSessionId, childSessionId);
  await subagentCompletionBroker.wait({ parentSessionId, childSessionIds: [childSessionId], timeoutMs, signal });
  signal?.throwIfAborted();
  return childView(childSessionId, parentSessionId);
}

async function startChild(input: ToolExecutionInput, args: LifecycleArgs) {
  const { action: _action, childSessionId: _child, timeoutMs: _timeout, message: _message, reason: _reason, ...start } = args;
  if (!start.prompt) throw new AgentValidationError("prompt is required to start a subagent.");
  const { child, spec } = await createConfiguredSubagent(input, { ...start, prompt: start.prompt });
  activeRuns.add(child.id);
  void runChildToCompletion(child.id, spec).catch(() => undefined).finally(() => activeRuns.delete(child.id));
  return childView(child.id, input.sessionId);
}

export const subagentLifecycleTool: RegisteredTool = {
  id: "subagent.lifecycle",
  label: "Control Subagent",
  description:
    "Control the full lifecycle of a subagent owned by the current primary agent: start, list, inspect, wait, message, pause, resume, cancel, close, or terminate. Lifecycle actions are limited to direct child sessions. start requires prompt; every action except start and list requires childSessionId; message requires message.",
  progressiveDetails:
    "Use start for asynchronous work when the parent should continue; profile, templateId, name, deliverable and acceptanceCriteria apply to start only; profile configures the same general-purpose subagent as subagent.delegate. Use the childSessionId returned by start or list for every later action, and pass timeoutMs only for wait. pause is resumable, cancel is terminal, close and terminate are hard stops, and message continues a stopped or completed child with new input.",
  category: "task",
  internalGate: "task",
  mutability: "task",
  resumeBehavior: "auto",
  inputSchema: lifecycleArgsSchema,
  async execute(input) {
    const args = lifecycleArgsSchema.parse(input.args);
    if (args.action === "start")
      return result(await startChild(input, args), "Started asynchronous subagent.");
    if (args.action === "list") {
      const parent = agentRuntimeStore.getSession(input.sessionId);
      if (parent.parentSessionId)
        throw new AgentValidationError("Only a primary agent can list subagents.");
      return result(
        (parent.childSessionIds ?? []).map((id) => childView(id, parent.id)),
        "Listed owned subagents.",
      );
    }

    const child = assertOwnedChild(input.sessionId, requiredChildSessionId(args));
    if (args.action === "inspect")
      return result(childView(child.id, input.sessionId), "Inspected subagent.");
    if (args.action === "wait")
      return result(
        await waitForChild(input.sessionId, child.id, args.timeoutMs ?? 5_000, input.abortSignal),
        "Waited for subagent.",
      );
    if (args.action === "message") {
      if (!args.message) throw new AgentValidationError("message is required.");
      if (activeRuns.has(child.id) && !terminalStatuses.has(child.status))
        throw new AgentValidationError("The subagent is already running; wait or pause it before messaging it.");
      agentRuntimeStore.updateSessionMetadata(child.id, { manualStop: null });
      agentRuntimeStore.updateSession(child.id, { prompt: args.message, status: "queued", updatedAt: nowIso(), completedAt: null });
      const spec: SubagentSpec = { profileId: child.profileId, prompt: args.message, nodeId: child.nodeId };
      activeRuns.add(child.id);
      void runChildToCompletion(child.id, spec, { input: { message: args.message } }).catch(() => undefined).finally(() => activeRuns.delete(child.id));
      return result(childView(child.id, input.sessionId), "Sent a new instruction to subagent.");
    }
    if (args.action === "resume") {
      if (!["paused", "interrupted", "completed"].includes(child.status))
        throw new AgentValidationError(`Cannot resume subagent in status ${child.status}.`);
      agentRuntimeStore.updateSessionMetadata(child.id, { manualStop: null });
      agentRuntimeStore.updateSession(child.id, { status: "queued", updatedAt: nowIso(), completedAt: null });
      const spec: SubagentSpec = { profileId: child.profileId, prompt: child.prompt, nodeId: child.nodeId };
      activeRuns.add(child.id);
      void runChildToCompletion(child.id, spec, { resume: true }).catch(() => undefined).finally(() => activeRuns.delete(child.id));
      return result(childView(child.id, input.sessionId), "Resumed subagent.");
    }
    const reason = args.reason ?? `Subagent ${args.action} by parent agent.`;
    if (args.action === "pause") {
      if (terminalStatuses.has(child.status)) throw new AgentValidationError("A terminal subagent cannot be paused.");
      await interruptAgentSessionsAndWait([child.id], reason);
      activeRuns.delete(child.id);
      if (runtimeFacade.streamMode() === "authoritative") {
        await runtimeFacade.stopSessionAuthoritative(child.id, "paused", reason);
        return result(childView(child.id, input.sessionId), "Paused subagent.");
      }
      return result(agentSessionRuntime.cancel(child.id), "Paused subagent.");
    }
    if (args.action === "cancel") {
      if (terminalStatuses.has(child.status)) return result(childView(child.id, input.sessionId), "Subagent already stopped.");
      await interruptAgentSessionsAndWait([child.id], reason);
      activeRuns.delete(child.id);
      if (runtimeFacade.streamMode() === "authoritative") {
        await runtimeFacade.stopSessionAuthoritative(child.id, "cancelled", reason);
      } else agentSessionRuntime.interrupt(child.id);
      if (runtimeFacade.streamMode() !== "authoritative")
        agentRuntimeStore.updateSession(child.id, { status: "cancelled", updatedAt: nowIso(), completedAt: nowIso(), resultSummary: reason });
      return result(childView(child.id, input.sessionId), "Cancelled subagent.");
    }
    await interruptAgentSessionsAndWait([child.id], reason);
    activeRuns.delete(child.id);
    if (runtimeFacade.streamMode() === "authoritative") {
      await runtimeFacade.stopSessionAuthoritative(child.id, "interrupted", reason);
    } else agentSessionRuntime.interrupt(child.id);
    return result(childView(child.id, input.sessionId), "Terminated subagent.");
  },
};

export const subagentLifecycleTools = [subagentLifecycleTool];
